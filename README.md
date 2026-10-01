# media/promo-video

Binary files for the Hachidori promo video. This branch has no history in common with `main`; the
HyperFrames source, the capture script and the instructions live in
[`media/promo-video/` on `main`](https://github.com/bee-san/hachidori/tree/main/media/promo-video).

- `media/promo-video/out/hachidori-promo.mp4`: the video, 1920×1080 H.264, 30 fps, 59.3 s
- `media/promo-video/out/hachidori-promo.gif`: the README preview, 720 px, 10 fps
- `media/promo-video/out/poster.jpg`, `media/promo-video/out/stills.jpg`: a poster frame and four stills
- `media/promo-video/video/assets/captures/`: the real Chrome screenshots the video is made from.
  `media/promo-video/build.sh --skip-capture` fetches them from here when they are missing.

The README links these files through jsDelivr, pinned to a commit of this branch. After
re-rendering, commit the new files here and update that commit hash in `README.md` on `main`.
