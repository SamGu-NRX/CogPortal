# Onboarding media delivery

The setup guide should stand on its own without video. A short recording may
reinforce the GitHub organization and fork workflow, but it must never contain
the only version of a command or recovery step.

## Recommended first release

Host one short, captioned clip as a versioned static asset in
`apps/portal/public/media/onboarding/`. Cloudflare serves `/media/*` directly,
without invoking the Worker, and the repository `_headers` file gives versioned
media an immutable one-year browser cache.

Keep the editable recording master outside Git. Commit only these web exports:

- `github-team-v1.webm` using VP9 or AV1;
- `github-team-v1.mp4` using H.264 as the broad compatibility fallback;
- `github-team-v1.webp` as the poster frame;
- `github-team-v1.vtt` for captions, plus a nearby HTML transcript.

Aim for 45–75 seconds and less than 10 MiB per video rendition. Keep every
individual file below Cloudflare Workers Static Assets' 25 MiB file limit.
Record at 1080p, export at 30 fps, avoid tiny cursor movements, and pause after
each click long enough for a new student to follow.

An example pair of exports from a lossless master is:

```sh
ffmpeg -i github-team-master.mov -vf "scale=1920:-2" -r 30 -c:v libvpx-vp9 -crf 34 -b:v 0 -an github-team-v1.webm
ffmpeg -i github-team-master.mov -vf "scale=1920:-2" -r 30 -c:v libx264 -crf 23 -preset slow -movflags +faststart -pix_fmt yuv420p -an github-team-v1.mp4
```

Render it with `preload="none"`, the poster image, native controls, captions,
and no autoplay. This protects first-page performance and accessibility while
still making the walkthrough one click away. Respect reduced-motion settings;
do not auto-pan or auto-zoom the web page around the video.

## When to move to Cloudflare Stream

Static assets are the best price/performance tradeoff for one optional short
clip: no additional service, player, or upload workflow is needed. Revisit
Cloudflare Stream only when the course has several videos, needs adaptive
bitrate playback for unreliable networks, or needs playback analytics. At that
point, retain the poster, captions, transcript, and non-video step list in the
portal.

## Recording checklist

- Use a synthetic GitHub organization and accounts; expose no personal email,
  tokens, notifications, or unrelated repositories.
- Show creating the organization, inviting a teammate, forking the canonical
  starter into the organization, and copying the clone URL.
- Use the same repository and command names shown in CogPortal.
- Validate captions manually and test keyboard-only playback.
- Test the WebM, MP4 fallback, poster, and transcript with throttled networking.
- Increment the filename (`v2`, `v3`) when replacing media so immutable caches
  never serve stale instructions.
