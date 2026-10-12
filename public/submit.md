# Submit a project to the Fintech Hackathon

Instructions for AI coding agents (Claude Code, Cursor, Codex, Foldo and others) submitting a team's project on
the team's behalf. Humans can use the form at {{ORIGIN}}/submit instead.

- Event: Fintech Hackathon, London, 13 October 2026, by Singapore Global Network × Generate at LSE
- **Deadline: Tuesday 13 October 2026, 20:10 London time (19:10 UTC). Entries close sharp.**
- One submission per team. It can be edited until submissions close.

## Rules for agents

1. **Never invent anything.** Team members, LinkedIn URLs, the contact email and the demo video link must come from
   the human. If you don't have one, ask. Do not use placeholder or example values.
2. **Draft only what you can support.** Write the title, one-line summary and description from the code, README and
   conversation, keeping the team's own words. Don't add users, numbers, traction or features the project doesn't
   show. If a template section has nothing to support it, ask the human or leave it short.
3. **Check before you send.** Validate with a dry run (step 3 below) and fix any errors it reports.
4. **Get an explicit yes.** Show the human the final JSON and ask "Submit this?" Only send it once they agree.
   If no human is reachable, don't submit. Stop and say what is missing.
5. **Hand over the edit link.** After submitting, give the human the `editUrl` and tell them to keep it private.
   Anyone with the link can edit the entry.
6. **Submit once.** If you get `409`, the project is already in. Update it with the edit link instead of resubmitting.

## Step 0: check submissions are open

```sh
curl -sS '{{ORIGIN}}/api/config'
```

If `submissionsOpen` is `false`, stop and tell the human to find an organiser. `tracks` lists the valid track ids.

## Step 1: collect the fields

| Field | Required | Limit | Notes |
| --- | --- | --- | --- |
| `track` | yes | `payments`, `access` or `fraud` | `payments` = Payments, `access` = Access to finance, `fraud` = Fraud and security. Propose one and let the human confirm |
| `title` | yes | 90 chars | The project name |
| `tagline` | yes | 160 chars | One line: who it helps and how |
| `description` | yes | 2,000 chars | See the template below |
| `members` | yes | 1–4 people | `[{ "name": "Full Name", "linkedin": "https://www.linkedin.com/in/…" }]`. LinkedIn is optional per person, but must be a full `https://` URL if given |
| `teamName` | no | 80 chars | |
| `contactEmail` | yes | | Only organisers see it |
| `videoUrl` | yes | | Loom or YouTube (unlisted is fine), **1 minute 30 seconds or less**. Judges stop at 1:30. The server can't check length or access, so ask the human to confirm both: under 1:30, and it plays in a private browser window |
| `demoUrl` | no | | Live app, Foldo share link or code repo, `https://` |

Optional fields can be left out or sent as `""`. A member without LinkedIn can be just `{ "name": "Full Name" }`.

You cannot record the video. Ask the human for the link. If they haven't recorded it yet, help them script it:

> 0:00 "Meet [name]. [Their money problem, with a number]." · 0:15 "Until now, [why it couldn't be done]. Now [what changed]." ·
> 0:25 one flow, live, wow moment by 1:00 · 1:05 "Real: [this]. Mocked: [that]. We protect users by [how]." ·
> 1:20 "[Who] pays, because [why]." Stop at 1:30.

**Description template.** Judges score real-world impact (30%), originality (25%), execution and craft (25%) and
trust and responsibility (20%), so cover each in plain words:

```
Who it's for: one specific person and the money problem they have.
What it does: the one flow shown in the demo.
What's new: why this couldn't have existed two years ago, or what others miss.
How it works: what is real, what is mocked, which data or APIs it uses.
Trust: what could go wrong for users, and what the project does about it.
```

## Step 2: build the JSON

```json
{
  "track": "payments",
  "title": "StuckPay",
  "tagline": "Shows freelancers exactly where an invoice payment is stuck",
  "description": "Who it's for: …\nWhat it does: …\nWhat's new: …\nHow it works: …\nTrust: …",
  "teamName": "Team StuckPay",
  "members": [
    { "name": "Full Name", "linkedin": "https://www.linkedin.com/in/handle" }
  ],
  "contactEmail": "team@example.com",
  "videoUrl": "https://www.loom.com/share/…",
  "demoUrl": "https://…"
}
```

(The values above show the shape only. Replace every one with the team's real details.)

## Step 3: dry run, then submit

Save the JSON to `submission.json`, then validate it. Nothing is saved:

```sh
curl -sS -X POST '{{ORIGIN}}/api/submissions?dryRun=1' -H 'content-type: application/json' --data @submission.json
```

`200 {"ok":true,"dryRun":true,…}` means it's valid. Show the human the JSON, get a yes, then submit for real:

```sh
curl -sS -X POST '{{ORIGIN}}/api/submissions' -H 'content-type: application/json' --data @submission.json
```

Success is `201 {"id":12,"editToken":"…","editUrl":"{{ORIGIN}}/submit?edit=…"}`.

## Updating an entry

Send the **complete** submission again (all fields, not just the changed ones) to the edit token:

```sh
curl -sS -X PUT '{{ORIGIN}}/api/submissions/<editToken>' -H 'content-type: application/json' --data @submission.json
curl -sS '{{ORIGIN}}/api/submissions/<editToken>'   # read back what's saved
```

`?dryRun=1` works on `PUT` too.

## Responses

| Status | Meaning | What to do |
| --- | --- | --- |
| `201` | Submitted | Give the human the `editUrl` |
| `200` | Dry run passed, or update saved | |
| `400` | Body isn't a JSON object | Send `content-type: application/json` and a JSON object |
| `403` | Submissions are closed | Tell the human to find an organiser at once |
| `409` | Already submitted (same title and contact email) | Use the edit link. Don't resubmit |
| `413` | Body too large | Shorten the description (2,000 chars max) |
| `422` | Validation failed | `errors` maps each field (e.g. `videoUrl`, `members.0.linkedin`) to a fix. Correct it and dry-run again |

Check whether submissions are open, and list the tracks: `GET {{ORIGIN}}/api/config`.
