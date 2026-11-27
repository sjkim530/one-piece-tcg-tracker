# Card scanner

Camera capture and identification are separate. `app.js` selects a usable
frame from advancing camera observations; it does not wait for OCR or require
pixel-perfect stillness. A captured frame remains visible while it is matched.
Failed attempts resume searching without changing the Auto capture preference.

`scan-vision.js` transfers pixels to `scan-vision-worker.js`. The worker uses
the pinned official OpenCV 4.12.0 browser build, ORB descriptors, a compact
lookup index, and geometric verification. Reference artwork is processed at
build time because the artwork CDN does not permit browser canvas access.
User photos stay in device memory and are discarded after each operation.

Artwork matches must have distributed artwork inliers and a plausible card
projection. Text-only feature matches are rejected. Identical reference
features retain all product aliases. A match is a candidate for confirmation,
not proof of foil treatment, grade, or condition. If visual evidence is
insufficient, a bounded OCR pass checks the captured image; it does not delay
the shutter. Manual number lookup remains available.

## Reference data

Install the build-only dependency in a virtual environment:

```sh
python -m pip install opencv-python-headless==4.12.0.88
python tests-scan-index.py
python build-scan-index.py --cache /path/outside/public/app/scan-cache
```

Only `scan-index/` is published. The generator uses the existing public catalog
proxy and caches reference features outside the app. The manifest records
coverage gaps and a content-hashed binary. Exact feature aliases preserve
every associated product ID. Failed catalog collection or inadequate coverage
keeps the previous index intact. The workflow can retain the packaged index
when the reference source is temporarily unavailable.

The initial reference download is about 25 MB, plus the OpenCV runtime.
Preparation is reported separately in the scanner. The service worker caches
the content-hashed reference binary; matching then runs locally. Browser cache
eviction can require another download. Current coverage and unavailable
artwork IDs are recorded in the manifest rather than assumed to be complete.

## Verification

```sh
node tests-camera.cjs
node tests-vision.cjs
node tests-scan.cjs
node tests-cache.cjs
python tests-scan-index.py
```

Before changing matching thresholds or feature selection, check real camera
photos against the complete index, including glare, sleeves, alternate art,
ambiguous printings, and unrelated backgrounds. Keep personal photo fixtures
outside the public repository. Controlled reference-image transformations test
geometry but do not establish real-phone accuracy. Record cold preparation,
capture, and matching latency separately; desktop timings do not establish
Android performance.

OpenCV is available under the Apache 2 license:
https://opencv.org/license/
