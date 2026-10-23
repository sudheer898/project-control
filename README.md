# Project Control on Vercel

Your multi-customer project dashboard as a Vercel app with password login.

- **Hosting:** Vercel serves the app; a free **Upstash Redis** database (added from Vercel's Storage tab) keeps your projects, saves and attachments.
- **No dependencies:** there are no npm packages and no build step.
- **Your data is included:** the IB and "constructions" projects are loaded into the database on the first visit.

## What's in the folder

| Path | Purpose |
|---|---|
| `api/server.js` | The serverless function: login, app page, data, saving, attachments |
| `app/index.html` | The dashboard |
| `seed/data/` | Starting data, copied into the database on first use |
| `vercel.json` | Sends every URL to the function, so nothing is public without a login |
| `.env.example` | The settings to add in Vercel |

## Deploy in 4 steps

### 1. Put the folder on GitHub
1. Create a **private** repository on <https://github.com/new>, for example `project-control`.
2. Click **uploading an existing file**.
3. Drag in everything inside this folder: `api`, `app`, `seed`, `vercel.json`, `package.json`, `README.md`, `.gitignore`, `.env.example`.
4. Click **Commit changes**.

### 2. Import it in Vercel
1. Go to <https://vercel.com/new>, sign in with GitHub and import the repository.
2. Leave **Framework Preset** as **Other**, and leave the build settings empty.
3. Open **Environment Variables** and add:
   - `DASH_EDITOR_PASSWORD`: a long password for people who edit
   - `DASH_SECRET`: a long random string (for example from <https://www.uuidgenerator.net/>, joined twice)
   - `DASH_VIEWER_PASSWORD`: optional, for read-only team members
4. Click **Deploy**.

### 3. Add the database
1. In your project, open **Storage → Create Database → Upstash → Upstash for Redis** (free plan).
2. Pick a region close to your users.
3. Connect it to the project for **Production** (and **Preview** if you like). Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

### 4. Redeploy
Go to **Deployments**, open the latest one, choose **⋯ → Redeploy**, then open your `https://YOUR-PROJECT.vercel.app` address and sign in.

Until the database is connected, the dashboard opens and shows your data but saving is switched off, and a message says so.

## Using it

- **Saving:** **Save changes** stores to the database, so everyone who signs in sees the same numbers. If two people save at the same time, the second is asked to reload rather than overwrite.
- **Projects:** add a customer with **Projects → Start a new project**, and switch customers with the selector at the top.
- **Attachments:** PDF, images, CSV or text, up to **4 MB** each (Vercel's request limit).
- **Reports:** PDF, Word, Excel and CSV are generated in the browser, in English, French or Hindi.
- **AI Assistant:** the built-in assistant answers standard questions and makes simple edits.
- **Customers:** don't give them the password. Send them the **Customer copy** reports as PDF.

## Updating later

- **New dashboard version:** replace `app/index.html` in GitHub. Vercel redeploys automatically and your data stays in the database.
- **Change a password:** edit the environment variable in Vercel and redeploy. Everyone has to sign in again.

## Security notes

- **Login required:** every page, data file and attachment needs a login. `vercel.json` routes all URLs through the function, so nothing is served publicly.
- **Built-in protections:**
  - Signed sessions that expire after 12 hours (`DASH_SESSION_HOURS` changes this).
  - Login rate limit: 10 failed tries per 15 minutes per address.
  - Saving needs the editor password; only approved data paths and file types are accepted.
  - HTTPS and browser security headers are set.
- **Private repository:** keep the GitHub repository private, because it contains your starting data.
- **Backups:** Upstash keeps the data. For an extra copy, download reports and the Excel workbooks regularly.
