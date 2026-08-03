# Atlens
Analyze any repo.

By inputting a GitHub repo into Atlens, you will be met with its main functions, what stack it uses, and an organized overview of the file system.

If you enter just a username, you can see all the repos that person has. You can then have Atlens analyze as you please.

## API

Anyone can call the Atlens API to get a full analysis of any public GitHub repository.

**Endpoint**
```
POST https://atlens-proxy.nzametto.workers.dev/api
Content-Type: application/json
```

**Request**
```json
{ "repo": "owner/repo" }
```
Also accepts full GitHub URLs (`https://github.com/owner/repo`).

**Response** (all fields, default)
```json
{
  "ok": true,
  "repo": "facebook/react",
  "purpose": "React is a JavaScript library for building user interfaces...",
  "techStack": {
    "languages": ["JavaScript", "Flow"],
    "frameworks": ["React"],
    "tools": ["Rollup", "Jest", "ESLint"]
  },
  "architecture": "Monorepo with packages/ containing the core renderer, reconciler, and platform-specific packages...",
  "entryPoints": ["packages/react/index.js", "packages/react-dom/index.js"],
  "keyFiles": [
    { "path": "packages/react/src/React.js", "role": "Main React exports" },
    { "path": "packages/react-reconciler/src/ReactFiber.js", "role": "Core reconciler logic" }
  ],
  "setupInstructions": "yarn install && yarn build",
  "openQuestions": ["How does concurrent mode scheduling work?"]
}
```

**Filtering with `fields`**

Pass a `fields` array to get only the parts you need:

```json
{ "repo": "owner/repo", "fields": ["purpose", "techStack"] }
```

Response:
```json
{
  "ok": true,
  "repo": "owner/repo",
  "purpose": "...",
  "techStack": { "languages": [...], "frameworks": [...], "tools": [...] }
}
```

**Available fields**

| Field | Type | Description |
|-------|------|-------------|
| `purpose` | string | 1–2 sentences on what the project does and produces |
| `techStack` | object | `{ languages, frameworks, tools }` arrays |
| `architecture` | string | 2–4 sentences on high-level structure |
| `entryPoints` | string[] | Main entry-point file paths |
| `keyFiles` | object[] | `{ path, role }` — the most important files |
| `setupInstructions` | string | How to install and run the project |
| `openQuestions` | string[] | 2–4 things worth investigating |

**Rate limit:** 5 requests per minute per IP.

Have fun analyzing!

![z cfmv bferkr wifd cltbp jkri](https://i.redd.it/jt0sr0dwyvjg1.jpeg "17")
