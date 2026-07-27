# Lecture Publisher

A dependency-free lecture website that validates structured JSON, supports three reusable designs, publishes permanent shareable links, and provides a protected storage administration panel.

## Visitor workflow

1. Open the website.
2. Choose a lecture JSON file.
3. Select **Build** to validate it locally.
4. Choose a design and select **Preview & publish**.
5. Copy the permanent `/lecture/<id>` URL.
6. Send the URL to another person.
7. Both people can reopen the saved lecture later using the same link.

Before a visitor builds a file, Preview opens the bundled example without saving it.

## Designs

- **Classic Academic**
- **Enhanced Modern**
- **Editorial Journal**

Schema versions `1.0` and `2.1` remain supported.

## Architecture

- **Cloudflare Worker + Static Assets** hosts the website and API together.
- **Cloudflare R2** privately stores complete lecture JSON files.
- **Cloudflare D1** stores title, link ID, selected design, object key, byte size and creation date.
- Public lecture links retrieve JSON through the Worker; the R2 bucket is not public.
- The current application upload limit is **25 MiB per normalized lecture JSON**. Change `MAX_LECTURE_BYTES` in `wrangler.jsonc` to adjust it, up to the applicable Cloudflare request limit.

## Admin panel

Open `/admin` after deployment. The panel provides:

- Current tracked storage in MB/GB
- Lecture count and oldest record
- Search and sorting by title, date or size
- Open and copy controls for every permanent link
- Individual lecture deletion
- Oldest-first cleanup of 10%, 20%, 50% or all stored bytes

The requested initial password is `0000`, but it is stored only as a Worker secret and never committed to browser code. Change it after initial testing.

## Cloudflare setup

### Requirements

- A free Cloudflare account
- Node.js
- R2 enabled in the Cloudflare dashboard; R2 may require completing its subscription/checkout flow even when usage stays inside the free allowance

### 1. Authenticate Wrangler

```bash
npx --yes wrangler@4.34.0 login
```

### 2. Create the D1 database

```bash
npx --yes wrangler@4.34.0 d1 create lecture-links --location apac
```

Copy the returned database UUID into `wrangler.jsonc`, replacing:

```text
REPLACE_WITH_D1_DATABASE_ID
```

### 3. Create the private R2 bucket

```bash
npx --yes wrangler@4.34.0 r2 bucket create lecture-links
```

Do not enable public bucket access. Lectures are served through the Worker.

### 4. Apply the D1 migration

```bash
npx --yes wrangler@4.34.0 d1 migrations apply lecture-links --remote
```

### 5. Build and validate

```bash
npm test
npm run build
```

### 6. Deploy the Worker and website

```bash
npx --yes wrangler@4.34.0 deploy
```

Wrangler prints a `workers.dev` URL. That URL becomes the permanent origin used by published lecture links.

### 7. Configure the admin secrets

Set the requested initial password:

```bash
printf '0000' | npx --yes wrangler@4.34.0 secret put ADMIN_PASSWORD
```

Create a long random session-signing secret:

```bash
openssl rand -base64 48 | npx --yes wrangler@4.34.0 secret put SESSION_SECRET
```

The secret commands create a new Worker version. Redeploy afterward only when source or configuration changes.

## Local development

Copy the example local secret file:

```bash
cp .dev.vars.example .dev.vars
```

Set a local password and session secret inside `.dev.vars`, then run:

```bash
npm run dev
```

For local D1 migrations:

```bash
npx --yes wrangler@4.34.0 d1 migrations apply lecture-links --local
```

## Useful routes

```text
/                         Publisher
/lecture/<uuid>           Permanent public lecture
/admin                    Password-protected admin panel
POST /api/lectures        Publish a lecture
GET  /api/lectures/<uuid> Retrieve a lecture
```

## Storage behavior

D1 is the source of truth for tracked byte totals. Every successful R2 upload records its exact object size in D1. Cleanup deletes R2 objects first and then removes their D1 rows. Because complete lectures are deleted, the actual freed amount can be slightly greater than the requested percentage.

The storage bar uses `STORAGE_ALLOWANCE_BYTES` from `wrangler.jsonc`. It is a dashboard reference, not an automatic billing stop.

## Security notes

- Admin credentials are Worker secrets.
- Admin sessions are HMAC-signed, `HttpOnly`, `Secure`, and `SameSite=Strict`.
- Secret comparisons use timing-safe Web Crypto operations.
- Login attempts are throttled after repeated failures.
- Publishing is limited per IP per hour.
- Lecture content is normalized and HTML-escaped by the trusted renderer.
- R2 objects are private and have unguessable UUID-based keys.
- State-changing routes reject cross-origin browser requests.

## Project files

```text
worker/src/index.js          Worker API and static routing
migrations/0001_initial.sql  D1 schema
lecture.html / lecture.js    Public permanent-link reader
admin.html / admin.js        Storage administration panel
lecture-renderer.js          Shared validator and safe renderer
scripts/build.mjs            Static asset build
wrangler.jsonc               Worker, R2, D1 and asset bindings
```
