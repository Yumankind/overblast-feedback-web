# @overblast/feedback

A feedback button for any website. The person using your site presses it (or a shortcut, or shakes
their phone), says what is wrong, optionally **points at the part of the page that is wrong**, and
sends it. The report lands in your Overblast workspace as a **task**, carrying the selected element,
the recent console lines and requests, the browser, your own id for that person, and a screenshot
when they chose to attach one.

```sh
npm i @overblast/feedback@^0.2.0
```

Zero runtime dependencies. ESM and types, plus a single-file build for a `<script>` tag. About 33 KB
gzipped, and an optional 1.5 KB recorder for `<head>` ([below](#catch-errors-from-the-first-line)).

---

## Quick start

You need a **feedback key** (`obfk_…`). Make one on the workspace's Feedback keys page in the
Overblast console, and add your site's origin (`https://example.com`) to the key: the key is refused
from any origin it does not list.

### With a bundler

```ts
import { init } from '@overblast/feedback';

const feedback = init({
  key: 'obfk_your_key',
  reporter: { accountRef: currentUser.id, email: currentUser.email }, // optional
});
```

That is all: a small **Feedback** button appears in the bottom-right corner, `⌘⇧F` / `Ctrl+Shift+F`
opens the sheet, and shaking a phone does too.

### With a script tag

```html
<script
  src="https://cdn.jsdelivr.net/npm/@overblast/feedback@0.2/dist/overblast-feedback.global.js"
  data-key="obfk_your_key"
  defer
></script>
```

With `data-key` the script starts itself. It also reads `data-endpoint`, `data-app-version`,
`data-position` (`bottom-right`, `bottom-left`, `top-right`, `top-left`), `data-button` (`"false"` never, `"true"` always, otherwise hidden while the site's chat is on the page),
`data-shortcut` (`"false"` turns it off), `data-shake="false"` and `data-device="false"`. The started instance is
`window.OverblastFeedback.instance`.

Without `data-key`, start it yourself:

```html
<script src="…/overblast-feedback.global.js"></script>
<script>
  const feedback = OverblastFeedback.init({ key: 'obfk_your_key' });
</script>
```

---

## Options

```ts
init({
  key: 'obfk_…',                                    // required
  endpoint: 'https://brain.deployd.network/v1/feedback',
  reporter: { email, name, accountRef },            // or () => ({ … }), read at send time
  trigger: {
    button: 'auto',                                 // hidden while the site's chat is on the page; true/false force; or { position, show }
    shortcut: 'mod+shift+f',                        // or false; `mod` is ⌘ on Apple, Ctrl elsewhere
    shake: true,                                    // touch devices with a motion sensor
  },
  appVersion: '2.4.1',
  build: '412',
  extra: { plan: 'pro' },                           // ≤ 20 keys, values become strings ≤ 200
  captureScreenshot: async () => blob,              // your own screenshot (see below)
  privateSelector: '[data-overblast-private]',
  locale: 'pt-PT',                                  // what context.locale says; default navigator.language
  labels: { title: 'Enviar comentário', send: 'Enviar' },
  captureConsole: true,
  captureNetwork: true,
  onSent: ({ id, taskId, conversationId }) => {},
  device: true,                                     // false: never register, whatever the key says
  errorPrompt: true,                                // false: never show the error prompt here
  appHosts: ['api.example.com'],                    // your API's hosts, for the error prompt
});
```

| Option | What it does |
|---|---|
| `key` | The workspace's public feedback key. It is not a secret: it only files reports into that workspace, and it can be revoked. |
| `reporter` | Who is reporting. `accountRef` is **your** id for this person (a customer id, a user id), so the team can find them in your own system. When you give an `email`, the sheet does not ask for one. A function is called each time a report is sent. |
| `trigger.button` | The floating button. It lives in a shadow root, so your CSS cannot break it and its CSS cannot leak onto your page. By default (`'auto'`) it steps aside when the site's chat is on the page (see [With the site's chat](#with-the-sites-chat)); `true` and `false` force it. |
| `trigger.shortcut` | `mod+shift+f` by default. Combinations use `mod`, `ctrl`, `meta`, `alt`, `shift` and a key (`f`, `period`, `slash`). If your page already handles the same keys and calls `preventDefault()`, the shortcut stands aside. |
| `trigger.shake` | Shake to report on phones and tablets. See [Shake on iOS](#shake-on-ios). |
| `captureScreenshot` | Your own screenshot of the viewport, for when the built-in one is not good enough on your page. Return a `Blob` (PNG, JPEG or WebP) or `null`. Private elements are still blanked on it. |
| `privateSelector` | Elements whose content is never sent. `[data-overblast-private]` always counts as well. |
| `labels` | Any of the words the library shows. The full list and the English defaults are exported as `DEFAULT_LABELS`. |
| `captureConsole`, `captureNetwork` | Turn the recording of console lines or of requests off. |
| `fetch` | The `fetch` used to send the report. Defaults to your page's own, before the library wrapped it. |
| `device` | `false` keeps device registration off on this site, whatever the key says. See [Device verification](#device-verification). |
| `errorPrompt` | `false` keeps the [error prompt](#the-error-prompt) off on this site, whatever the key says. |
| `appHosts` | Hosts besides the page's own whose 5xx answers and failed requests count for the error prompt: `api.example.com`, `*.example.com`, or an origin. |

### Settings that live on the key

Four things are switched on the key in the Overblast console rather than in code, so they can be
changed without a release: device verification, the error prompt, whether screenshots are offered,
and the kinds of report the key takes. With one kind (bugs only, say) the sheet has no category
choice and is titled "Report a problem" (`labels.titleSingle`); with several, only those are shown,
the first chosen. `report()` with a kind the key does not take is refused on this side with the
door's own `403 category_not_accepted`, and nothing is sent. The library reads them in idle time after `init` (`GET …/v1/feedback/config`), keeps the
answer in `localStorage` with its ETag, asks again at most every five minutes on a long-lived page,
and uses the kept answer when offline. Until it has ever had an answer it behaves as the defaults:
no device registration, no error prompt, screenshots offered. Your own options can only turn these
off, never on.

## The instance

```ts
feedback.open();                  // open the sheet
feedback.close();
feedback.setReporter({ accountRef: 'cus_8812', email: 'ana@example.com' }); // after sign-in; null clears
const anchor = await feedback.pick();   // let the person point at an element; null if they cancel
await feedback.enableShake();     // iOS: ask for motion permission. Call it from a tap.
await feedback.deviceLevel();     // 'registered' or 'none' (see Device verification)
feedback.destroy();               // remove the button, the listeners and every wrapper
```

### Sending without the sheet

```ts
const { id, taskId, conversationId } = await feedback.report({
  message: 'Checkout failed after the card step',
  category: 'bug',                       // bug | idea | question | other
  element: document.querySelector('#pay'), // or an anchor from pick()
  screenshot: true,                      // capture now; or a Blob of your own
  reporter: { email: 'ana@example.com' },
  extra: { orderId: 'o_31' },
  includeLogs: true,                     // false leaves out the console lines, the log file and the requests
});
```

`report()` rejects with a `FeedbackError` carrying `status`, `code`, `field` (for
`invalid_field`) and `retryAfter` (for `rate_limited`, in seconds). Its `message` is a sentence you
may show as it is.

---

## What is sent, and how to keep things out

The sheet tells the person, before they press Send, exactly what goes with their message: the
selected element, the screenshot, "logs from this session", and the page address and browser
details.

- **The screenshot is opt-in, every time.** The box is unticked by default. When the person ticks
  it they see the image, and can remove it.
- **Mark anything private** with `data-overblast-private` (or your own `privateSelector`):

  ```html
  <div class="account" data-overblast-private>…</div>
  ```

  A private element is painted over with a solid box on the screenshot, and if the person points at
  it (or at something inside it), the report says *where* it is (selector, tag, box) but never
  *what* it says: no text, no label, no HTML. **Password fields and card fields** (`type=password`,
  `autocomplete=cc-*`, names like `cardNumber` or `cvc`) are treated as private on every page,
  whether you mark them or not.
- **The selected element's HTML** is its own tag only: the `id`, `class`, `role`, `name`, `type`,
  `href` and `aria-*` attributes, its own text, and `…` where its children were. Never the value of
  a field.
- **Logs** are console lines (`debug`, `info`, `log`, `warn`, `error`), uncaught errors and unhandled
  rejections, each at most 4,000 characters (see [Busy logs](#busy-logs) for how many). Recording
  pauses while the sheet is open, so the sheet's own activity is never in the report. Before a line
  is stored, anything that
  looks like a bearer token, an API key (`sk-…`, `sk_live_…`, `ob_live_…`, `obfk_…`, GitHub, Slack,
  AWS, Google), a JWT, a card number (Luhn-checked) or a `password=` / `token=` pair is replaced by
  `[redacted]`. Redaction catches what looks like a secret; it cannot know your data, so do not log
  what must not leave the device.
- **Requests** (`fetch` and `XMLHttpRequest`) are the last 100: method, address **without its query
  string or fragment**, status (`0` when there was no answer) and time. Never a body, never a
  header. The wrappers are transparent: same arguments, same `this`, same return value, same errors,
  and `destroy()` puts the originals back.
- **The page address** keeps its query string (the team often needs `?step=2`) but loses its
  fragment, and the values of parameters such as `token`, `key`, `code`, `access_token`, `state`
  and `password` are replaced by `[redacted]`.
- **A device id** is a random value kept in `localStorage` under `ob-feedback-device`, sent as
  `context.deviceId`. It is not tied to anything else.
- **A device key** (see below) is a key pair kept in IndexedDB (`overblast-feedback`, store
  `device`). Only its public half and the signatures it makes leave the browser.

## The screenshot

With `captureScreenshot`, your function is used, for example with
[html2canvas](https://html2canvas.hertzen.com):

```ts
import html2canvas from 'html2canvas';

init({
  key: 'obfk_…',
  captureScreenshot: async () => {
    const canvas = await html2canvas(document.body, {
      x: scrollX, y: scrollY, width: innerWidth, height: innerHeight,
      ignoreElements: (el) => el.hasAttribute('data-overblast-feedback'),
    });
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  },
});
```

Return the **viewport**, not the whole page: the library paints private boxes and the selected
element's outline where they are on screen. If it cannot paint on your image and something private
is on screen, the screenshot is dropped rather than sent unblanked.

Without the hook, a built-in best effort clones the page with its computed styles into an SVG and
draws it on a canvas. It is good on ordinary pages and has limits worth knowing:

- Images from other origins appear only when they were served with CORS headers; otherwise their
  place is left blank. CSS background images, web fonts and `::before` / `::after` content do not
  come through (text falls back to a system font).
- `<iframe>`, `<video>` and plug-ins are drawn as grey boxes. A `<canvas>` comes through unless
  something cross-origin has tainted it.
- Fixed elements are pinned where they are on screen; sticky ones are drawn where they sit in the
  flow.
- Safari may refuse to read back the drawing. Pages with more than 6,000 elements are not
  attempted.

When a screenshot cannot be taken, the sheet says so and the report is sent without one. The
picture is JPEG, at most 2,400 px on its long side and under 5 MB.

## Shake on iOS

On Android and most browsers, shaking works as soon as the page loads. iOS Safari keeps motion
events silent until the person grants permission, and the request may only be made from inside a
tap. The library never asks on its own: the first time the sheet is opened from the button on an
iPhone, it offers "Shake your phone to send feedback next time" with a **Turn on** link, which is
the tap that asks. Motion listening has to be re-armed on each visit, and again only from a tap, so
once the person has said yes, pressing the button on a later visit re-arms shake as well (the library
remembers the yes under `localStorage` `ob-feedback-shake`, and a "No thanks" the same way).

If you would rather ask from your own settings screen, call `feedback.enableShake()` from that
button's click handler.

## The error prompt

When the key's owner switches it on, the library may offer a report after something goes wrong: a
small pill at the bottom of the page, "Something may have gone wrong. Tell us?", with **Report** and
a close button, in the page's light or dark scheme. It is not a dialog, and it keeps out of the way:

- **What counts**, among the kinds the key lists: an uncaught error or unhandled rejection (not one
  your code caught and logged); a 5xx answer from the page's own origin or your `appHosts` (not a
  4xx, which is usually the person's own input, and not another site's); a request to those hosts
  that never answered (an abort is not a failure). The library's own requests never count.
- **When**: at least 10 seconds after `init`; not while the person is typing (a key pressed in a
  text field in the last 5 seconds, or the on-screen keyboard up; a field that merely has focus does
  not count), waiting up to 30 seconds for that to end before giving up; not while the sheet is
  open; only while the page is visible. While it shows, it rides above the on-screen keyboard.
- **How often**: once per page, at most once per the key's `minHoursBetween` on this browser, and
  after two closes without reporting, not again for seven days. Errors a second apart are one.
- **How it behaves**: it fades in (not with reduced motion), stays about 8 seconds, longer while the
  pointer is over it, and screen readers announce it politely. **Report** opens the sheet as a bug,
  with `trigger: error_prompt`, so the error is among the lines just before. Each prompt is a line in
  the log (`error prompt shown`, `error prompt dismissed`, `error prompt went by itself`, `error prompt: reporting`), so a report says whether the person was prompted.

Labels: `promptText`, `promptReport`, `promptClose`.

## With the site's chat

When the page also runs Overblast's site chat (`window.InfiniteAgent`), the chat is the one button in
the corner: the library hides its own, including when the chat loads later (it listens for the chat's
`infinite:ready` event). Everything else keeps running: recording, the shortcut, shake and
`report()`. And:

- **Reports land in the visitor's conversation.** The library signs with the chat's device instead of
  its own, so the task points at the conversation and the conversation shows the task. When the chat
  has no device to lend (not registered yet, or "forget me"), or the door refuses it, the library's
  own device is used and the report is filed as before.
- **The chat can open the sheet.** The library tells the chat what this page can do (pointing at an
  element, a screenshot, shake, and the key's categories) and hands it the sheet: the chat's agent, or
  its "Report a problem" entry, opens it with the visitor's words. Nothing is sent until the visitor
  presses Send.
- **The error prompt comes from the chat's launcher**, after the same rules as above. If the chat is
  busy or offers no such prompt, nothing is shown.

No setup: it happens when both are on the page.

## Catch errors from the first line

The library records from the moment `init` runs. Errors thrown before that (a script that failed in
`<head>`, a crash while the page was still loading) happen before it exists. To keep them, put the
early recorder first in `<head>`, before any other script, without `async` or `defer`:

```html
<script src="https://cdn.jsdelivr.net/npm/@overblast/feedback@0.2/dist/overblast-feedback-early.global.js" data-fetch></script>
```

It is 1.5 KB gzipped and has no dependencies. It records `console.warn`, `console.error`, uncaught
errors and unhandled rejections, and with `data-fetch` the requests that failed (thrown, or answered
4xx/5xx), at most 200 lines, redacted by the same rules as the library. They wait on
`window.__overblastFeedbackEarly`. When `init` runs, it takes them over with their original times,
takes over the recorder's wrappers rather than wrapping them again, and removes the buffer; the
recorder never restores anything itself.

With a bundler, import it first in the earliest entry the page loads:

```ts
import { startEarly } from '@overblast/feedback/early';
startEarly({ fetch: true });
```

## Busy logs

A page can log far more, and far faster, than is worth sending. The library keeps it bounded:

- **At most 50 lines a second** enter the buffer; warnings and errors still enter up to 200 a second.
  Past that, lines are counted and dropped without being formatted or redacted, so a logging storm
  costs the page very little, and one line (`1,204 lines dropped in 3 s (too fast)`) marks the gap.
- **A line repeated** straight after itself is stored once, with the number of times it occurred
  (`repeat`, the first included) and the time of the last one (`last`).
- **The buffer holds up to 20,000 lines and 1 MB.** When it is full, the oldest debug and info lines
  go first: an error from five minutes ago outlives a thousand debug lines from the last second.

Each report carries two views of it. `logs` is an **excerpt** of at most 500 lines and 256 KB: every
warning and error from the two minutes before the sheet opened, then the newest other lines. The
**log file**, sent when the buffer holds more than the excerpt, is the whole buffer as gzip-compressed NDJSON (made with the browser's
`CompressionStream`, uncompressed where there is none), attached to the task as
`logs.ndjson.gz`. A report must fit in 8 MB, so when a screenshot leaves less room the oldest lines
of the file are cut, and its first line says how many.

## What happens in Overblast

Each report becomes a **task** in the workspace, titled from the first line of the message (`Bug:`,
`Idea:`, `Question:`, `Feedback:`) and tagged `feedback`, with the category and the platform. The
description carries the message, the reporter, your account reference, the page and the element in
plain lines, and the last error and failed request before the report was opened; the screenshot, a
`feedback-report.json` (element, logs, requests, context) and the log file are attached to the
task. If the key names a group, the task is assigned to it.

**An email conversation exists only when the report carries an email address.** Even then, nothing
is sent to that address when the report arrives (it is unverified, and anyone could type anyone's
address): the thread opens when someone on the team replies from the task. Without an email there is
nobody to answer, and no conversation.

## Device verification

No code on your side: it follows the key's verification setting (`off` by default; `flag` or
`require` turn it on, in the console's Advanced section), and the worker does the rest.

When the key has it on, the first time a report is about to be sent (in idle time once the sheet opens, or on the first
`report()` call), the library makes an ECDSA P-256 key pair with WebCrypto, **non-extractable**, so
the private half never leaves the browser's key store, not even to this library, and keeps it in
IndexedDB. It registers the public half with the door once: it asks for a challenge, solves a small
proof of work (a SHA-256 search in a Web Worker, so the page never janks; how long it takes depends
on the difficulty the door sets, and it gives up after 20 seconds), and receives a device id. From then on every report carries
three headers, `X-Overblast-Feedback-Device`, `X-Overblast-Feedback-Time` and
`X-Overblast-Feedback-Signature`, a signature over the exact bytes of the body.

What that buys: the door's per-device limits count a key that took work to make, rather than an id
anyone can invent, and a registered browser gets the more generous limits below. What it does not
buy is proof. A browser cannot prove it is a real browser driven by a real person, the way App
Attest or Android key attestation lets a native app prove it is the genuine app on genuine
hardware; the web's level is always `registered`, never `attested`. **It is a price, not a proof**:
a script can pay the proof of work too, it just has to pay it for every device it pretends to be,
and registrations are limited per address. Nor does a signed report say the person is honest.

It never costs a report. With no IndexedDB or WebCrypto (some private windows, old browsers,
sandboxed frames), a registration the door refuses or rate-limits, or a proof of work that runs too
long, the report is sent unsigned. Send waits at most about 3 seconds for a registration still under
way. If the door no longer knows the device, or refuses its signature, the library forgets it,
registers a new one and sends once more. If your key is set to accept only registered devices
(`verification: require`) and this browser could not register, the sheet shows the door's sentence.

`feedback.deviceLevel()` says `registered` or `none`. `init({ device: false })` turns it all off.
If your page sets a Content Security Policy, `worker-src blob:` lets the proof of work run in a
worker; without it the work runs on the main thread in small slices.

## Limits and errors

The door's limits depend on whether the report is signed. Signed by a registered device: at most 10
reports an hour and 30 a day per device, and 30 an hour per IP. Unsigned: 10 an hour per IP. The
key's own daily cap applies either way. Refused with `429`, the sheet shows the door's sentence, **keeps the draft** on
the device (message, category, email and element, under `localStorage` `ob-feedback-draft`) and
offers to send it again; it never retries in a loop. The same happens when the connection drops or
the door answers `5xx`. A revoked key (`401`), a disallowed origin or disabled key (`403`) and a
bad field (`400`) are shown and not kept, since sending again would not change the answer.

## Server rendering

Importing the package touches nothing global. Call `init` in the browser (in an effect, or after
mount). Called where there is no DOM, `init` returns an instance with no UI whose `report()` still
works.

---

## Source and releases

The package is developed in Overblast's monorepo, next to the worker it talks to, and published from
there to npm as **`@overblast/feedback`**. Its public mirror is
[github.com/Yumankind/overblast-feedback-web](https://github.com/Yumankind/overblast-feedback-web),
pushed by `scripts/mirror.sh` with `git subtree split`; a release is a tag on the mirror.

```sh
pnpm install
pnpm test          # node --test, with happy-dom as the page
pnpm run typecheck
pnpm build         # dist/: ESM + .d.ts, and dist/overblast-feedback.global.js
```

MIT licensed.
