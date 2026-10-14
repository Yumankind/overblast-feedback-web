# @overblast/feedback

A feedback button for any website. The person using your site presses it (or a shortcut, or shakes
their phone), says what is wrong, optionally **points at the part of the page that is wrong**, and
sends it. The report lands in your Overblast workspace as a **task**, carrying the selected element,
the recent console lines and requests, the browser, your own id for that person, and a screenshot
when they chose to attach one.

```sh
npm i @overblast/feedback
```

Zero runtime dependencies. ESM and types, plus a single-file build for a `<script>` tag. About 20 KB
gzipped.

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
  src="https://cdn.jsdelivr.net/npm/@overblast/feedback@0.1/dist/overblast-feedback.global.js"
  data-key="obfk_your_key"
  defer
></script>
```

With `data-key` the script starts itself. It also reads `data-endpoint`, `data-app-version`,
`data-position` (`bottom-right`, `bottom-left`, `top-right`, `top-left`), `data-button="false"`,
`data-shortcut` (`"false"` turns it off) and `data-shake="false"`. The started instance is
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
    button: true,                                   // or false, or { position: 'bottom-left' }
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
});
```

| Option | What it does |
|---|---|
| `key` | The workspace's public feedback key. It is not a secret: it only files reports into that workspace, and it can be revoked. |
| `reporter` | Who is reporting. `accountRef` is **your** id for this person (a customer id, a user id), so the team can find them in your own system. When you give an `email`, the sheet does not ask for one. A function is called each time a report is sent. |
| `trigger.button` | The floating button. It lives in a shadow root, so your CSS cannot break it and its CSS cannot leak onto your page. |
| `trigger.shortcut` | `mod+shift+f` by default. Combinations use `mod`, `ctrl`, `meta`, `alt`, `shift` and a key (`f`, `period`, `slash`). If your page already handles the same keys and calls `preventDefault()`, the shortcut stands aside. |
| `trigger.shake` | Shake to report on phones and tablets. See [Shake on iOS](#shake-on-ios). |
| `captureScreenshot` | Your own screenshot of the viewport, for when the built-in one is not good enough on your page. Return a `Blob` (PNG, JPEG or WebP) or `null`. Private elements are still blanked on it. |
| `privateSelector` | Elements whose content is never sent. `[data-overblast-private]` always counts as well. |
| `labels` | Any of the words the library shows. The full list and the English defaults are exported as `DEFAULT_LABELS`. |
| `captureConsole`, `captureNetwork` | Turn the recording of console lines or of requests off. |
| `fetch` | The `fetch` used to send the report. Defaults to your page's own, before the library wrapped it. |

## The instance

```ts
feedback.open();                  // open the sheet
feedback.close();
feedback.setReporter({ accountRef: 'cus_8812', email: 'ana@example.com' }); // after sign-in; null clears
const anchor = await feedback.pick();   // let the person point at an element; null if they cancel
await feedback.enableShake();     // iOS: ask for motion permission. Call it from a tap.
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
  includeLogs: true,                     // false leaves out the console lines and the requests
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
- **Logs** are the last 500 console lines (`debug`, `info`, `log`, `warn`, `error`), uncaught errors
  and unhandled rejections, each at most 4,000 characters. Before a line is stored, anything that
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
- **A device id** is a random value kept in `localStorage` under `ob-feedback-device`, used by the
  door's per-device limits. It is not tied to anything else.

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

## What happens in Overblast

Each report becomes a **task** in the workspace, titled from the first line of the message (`Bug:`,
`Idea:`, `Question:`, `Feedback:`) and tagged `feedback`, with the category and the platform. The
description carries the message, the reporter, your account reference, the page and the element in
plain lines; the screenshot and a `feedback-report.json` (element, logs, requests, context) are
attached to the task. If the key names a group, the task is assigned to it.

**An email conversation exists only when the report carries an email address.** Even then, nothing
is sent to that address when the report arrives (it is unverified, and anyone could type anyone's
address): the thread opens when someone on the team replies from the task. Without an email there is
nobody to answer, and no conversation.

## Limits and errors

The door accepts at most 10 reports an hour and 30 a day per device, 30 an hour per IP, and the
key's own daily cap. Refused with `429`, the sheet shows the door's sentence, **keeps the draft** on
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
