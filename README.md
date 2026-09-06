# AgentBee Kudos Submission Widget

A simple public form for agents to submit an award. On submit, it creates a
published post in the Circle space **Kudos - Agent Submitted**
(`https://app.agentbee.net/c/kudos-agent-submitted`), titled with the
agent's business name, containing either the link they pasted or the image
they uploaded.

## Fields

1. Business Name
2. Link to the award, **or** an uploaded image (agent picks one)
3. Submit

A hidden honeypot field and a confirmation checkbox provide basic spam
protection — no third-party CAPTCHA involved.

## How it works

- `index.html` — the form. Plain HTML/CSS/JS, no build step.
- `api/submit-kudos.js` — a Vercel serverless function that validates the
  submission, uploads the image to Circle (if provided) using Circle's
  direct-upload flow, and creates the post via Circle's Admin API v2.

Your Circle API token stays server-side as a Vercel environment variable —
it's never sent to the browser.

## Deploy it (GitHub + Vercel)

1. **Unzip** this project.
2. **Create a new, empty GitHub repository** (e.g. `agentbee-kudos-widget`)
   and push these files into it:
   ```
   git init
   git add .
   git commit -m "Kudos submission widget"
   git branch -M main
   git remote add origin <your new repo URL>
   git push -u origin main
   ```
3. **Import the repo into Vercel**: vercel.com → *Add New* → *Project* →
   select the repo. No framework preset is needed — leave the defaults.
4. Before or right after the first deploy, go to **Project Settings →
   Environment Variables** and add:
   - `CIRCLE_API_TOKEN` — your Circle **Admin API v2** token. In Circle:
     *Settings → Developers → Tokens*, create or copy an Admin V2 token.
   - (Optional) `CIRCLE_SPACE_ID` — already defaults to `2843717`, the
     Kudos - Agent Submitted space. Only set this if that ever changes.
   - (Optional) `CIRCLE_API_BASE_URL` — already defaults to
     `https://app.circle.so/api/admin/v2`. See the **note on the API
     endpoint** below before you need to touch this.
   - (Optional) `CIRCLE_AUTHOR_EMAIL` — if you want submitted posts
     attributed to a specific Circle member instead of the token's
     default account.
5. **Deploy** (or redeploy, so the new env vars take effect).
6. Test it: submit a real entry through the deployed URL and confirm it
   shows up at `https://app.agentbee.net/c/kudos-agent-submitted`.
7. Share the deployed URL with agents, or embed it in Circle as an iframe.

## A note on the Circle API endpoint

This widget calls Circle's Admin API v2 at `https://app.circle.so/api/admin/v2`
for both the post-creation and image-upload steps — this is Circle's
documented base URL and matches how the rest of the AgentBee widgets talk to
Circle. If a submission ever fails with an error mentioning a 404 or 401 from
Circle, it's worth double-checking the exact base URL and token type shown
under *Developers → Tokens* in your Circle admin settings, and updating the
`CIRCLE_API_BASE_URL` / `CIRCLE_API_TOKEN` environment variables in Vercel
accordingly — no code changes needed.

## Limits

- Images are capped at **4 MB** in both the form and the server function,
  to stay under Vercel's request size limit for serverless functions. If
  agents commonly have larger award images, ask them to resize first, or
  let Geoff know and this can be reworked to upload straight from the
  browser to storage instead of through the function.
- Accepted image types: JPG, PNG, WEBP, GIF.

## Local testing

To try the real form against real Circle data:
```
npm install
npx vercel dev
```
Then open the local URL Vercel prints, and set the environment variables in
a local `.env` file (see `.env.example`) or via `vercel env pull`.

There's also an offline smoke test that mocks Circle's API entirely — no
token or network needed. It checks the link flow, the image-upload flow, the
honeypot, and validation, and prints the exact payload that would be sent to
Circle for each:
```
npm install
node test/smoke-test.js
```
