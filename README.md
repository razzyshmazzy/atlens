# Atlens
Analyze any repo.

By inputting a GitHub repo into Atlens, you will be met with its main functions, what stack it uses, and an organized overview of the file system.

If you enter just a username, you can see all the repos that person has. You can then have Atlens analyze as you please.

## API

Anyone can call the Atlens API to get a description of what a GitHub repository does.

**Endpoint**
```
POST https://atlens-proxy.atlens-api.workers.dev/api
Content-Type: application/json
```

**Request**
```json
{ "repo": "owner/repo" }
```
Also accepts full GitHub URLs (`https://github.com/owner/repo`).

**Response**
```json
{
  "ok": true,
  "repo": "torvalds/linux",
  "purpose": "The Linux kernel is the foundational layer of the Linux operating system, managing hardware resources and providing core services to user-space programs."
}
```

**Rate limit:** 5 requests per minute per IP.

Have fun analyzing!

![z cfmv bferkr wifd cltbp jkri](https://i.redd.it/jt0sr0dwyvjg1.jpeg)