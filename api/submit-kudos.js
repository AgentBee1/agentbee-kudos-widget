// api/submit-kudos.js
//
// Handles the Kudos submission form: validates the entry, uploads an image to
// Circle (if one was provided) via the direct-upload flow, and creates a
// published post in the "Kudos - Agent Submitted" space.
//
// Required environment variables (set these in the Vercel project settings):
//   CIRCLE_API_TOKEN     - Circle Admin API v2 token (Circle admin: Settings -> Developers -> Tokens -> Admin V2)
//
// Optional environment variables (sensible defaults already point at the
// AgentBee "kudos-agent-submitted" space, so you normally don't need these):
//   CIRCLE_SPACE_ID       - defaults to 2843717 (kudos-agent-submitted)
//   CIRCLE_API_BASE_URL   - defaults to https://app.circle.so/api/admin/v2
//   CIRCLE_AUTHOR_EMAIL   - if set, posts are attributed to this Circle member's email
//                           instead of the token owner's default account

const { formidable } = require('formidable');
const fs = require('fs');
const crypto = require('crypto');

const CIRCLE_API_BASE_URL = (process.env.CIRCLE_API_BASE_URL || 'https://app.circle.so/api/admin/v2').replace(/\/+$/, '');
const CIRCLE_SPACE_ID = process.env.CIRCLE_SPACE_ID || '2843717';
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;
const CIRCLE_AUTHOR_EMAIL = process.env.CIRCLE_AUTHOR_EMAIL || null;

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 MB — stays under Vercel's request body limit
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  if (!CIRCLE_API_TOKEN) {
    console.error('CIRCLE_API_TOKEN is not set.');
    res.status(500).json({ error: 'Server is not configured yet. (Missing CIRCLE_API_TOKEN.)' });
    return;
  }

  let fields, files;
  try {
    ({ fields, files } = await parseForm(req));
  } catch (err) {
    console.error('Form parse error:', err);
    const tooLarge = err && err.httpCode === 413;
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'That image is too large. Please keep it under 4 MB.' : 'Could not read the submitted form.'
    });
    return;
  }

  const businessName = firstValue(fields.businessName);
  const awardLink = firstValue(fields.awardLink);
  const honeypot = firstValue(fields.website);
  const confirmed = firstValue(fields.confirmNotRobot);
  const imageFile = firstValue(files.awardImage);

  // Honeypot: real visitors never see or fill this field in.
  if (honeypot) {
    console.warn('Honeypot triggered, silently rejecting submission.');
    // Respond as if it succeeded so bots don't learn to avoid the field.
    res.status(200).json({ ok: true });
    return;
  }

  if (!confirmed) {
    res.status(400).json({ error: 'Please confirm the checkbox before submitting.' });
    return;
  }

  if (!businessName || !businessName.trim()) {
    res.status(400).json({ error: 'Business name is required.' });
    return;
  }

  const hasLink = Boolean(awardLink && awardLink.trim());
  const hasImage = Boolean(imageFile && imageFile.size > 0);

  if (!hasLink && !hasImage) {
    res.status(400).json({ error: 'Please provide either a link to your award or an image.' });
    return;
  }

  if (hasLink && !isValidUrl(awardLink.trim())) {
    res.status(400).json({ error: 'That does not look like a valid link. Please include https://' });
    return;
  }

  if (hasImage) {
    if (imageFile.size > MAX_FILE_SIZE) {
      res.status(413).json({ error: 'That image is too large. Please keep it under 4 MB.' });
      return;
    }
    if (imageFile.mimetype && !ALLOWED_IMAGE_TYPES.includes(imageFile.mimetype)) {
      res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' });
      return;
    }
  }

  try {
    let bodyContent;

    if (hasImage) {
      const buffer = fs.readFileSync(imageFile.filepath);
      const uploaded = await uploadImageToCircle(buffer, imageFile);
      bodyContent = [
        {
          type: 'image',
          attrs: {
            url: uploaded.url,
            signed_id: uploaded.signed_id,
            content_type: imageFile.mimetype || 'image/png',
            width: '100%',
            alignment: 'center'
          }
        }
      ];
    } else {
      const link = awardLink.trim();
      bodyContent = [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: link,
              marks: [{ type: 'link', attrs: { href: link, target: '_blank' } }]
            }
          ]
        }
      ];
    }

    const post = await createCirclePost(businessName.trim(), bodyContent);
    res.status(200).json({ ok: true, url: post.url });
  } catch (err) {
    console.error('Kudos submission failed:', err);
    res.status(502).json({ error: 'Could not post your award to Circle right now. Please try again shortly, or let AgentBee know if this keeps happening.' });
  }
};

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      maxFieldsSize: 20 * 1024
    });
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ fields, files });
    });
  });
}

function firstValue(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function circleFetch(path, options) {
  const res = await fetch(`${CIRCLE_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CIRCLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options && options.headers ? options.headers : {})
    }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Circle API ${path} responded ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function uploadImageToCircle(buffer, imageFile) {
  const checksum = crypto.createHash('md5').update(buffer).digest('base64');
  const filename = (imageFile.originalFilename || 'kudos-award').replace(/[^a-zA-Z0-9._-]/g, '_');

  const uploadRecord = await circleFetch('/direct_uploads', {
    method: 'POST',
    body: JSON.stringify({
      blob: {
        key: `kudos/${Date.now()}-${filename}`,
        filename,
        content_type: imageFile.mimetype || 'application/octet-stream',
        byte_size: buffer.length,
        checksum
      }
    })
  });

  const directUpload = uploadRecord.direct_upload;
  if (!directUpload || !directUpload.url) {
    throw new Error('Circle did not return a direct upload URL.');
  }

  const putRes = await fetch(directUpload.url, {
    method: 'PUT',
    headers: directUpload.headers || { 'Content-Type': imageFile.mimetype || 'application/octet-stream' },
    body: buffer
  });

  if (!putRes.ok) {
    const t = await putRes.text().catch(() => '');
    throw new Error(`Uploading the image to storage failed (${putRes.status}): ${t.slice(0, 300)}`);
  }

  return { signed_id: uploadRecord.signed_id, url: uploadRecord.url };
}

async function createCirclePost(businessName, bodyContent) {
  const payload = {
    space_id: Number(CIRCLE_SPACE_ID),
    name: businessName,
    status: 'published',
    tiptap_body: {
      body: { type: 'doc', content: bodyContent }
    }
  };
  if (CIRCLE_AUTHOR_EMAIL) {
    payload.user_email = CIRCLE_AUTHOR_EMAIL;
  }

  const post = await circleFetch('/posts', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return post;
}
