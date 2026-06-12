import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runBrowserOperate } from "../tools/browser-operate-service/src/browser.js";

test("browser operate extracts links when selector is a container or the anchor itself", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/page`, waitUntil: "domcontentloaded" },
        { type: "extractLinks", selector: "body", label: "container" },
        { type: "extractLinks", selector: "a", label: "anchors" },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const links = result.data?.extractedLinks ?? [];
    assert.deepEqual(links.map((group) => group.label), ["container", "anchors"]);
    assert.equal(links[0]?.links[0]?.href, `${baseUrl}/next`);
    assert.equal(links[1]?.links[0]?.href, `${baseUrl}/next`);
  });
});

test("browser operate observe returns actionable controls instead of decorative images", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/page`, waitUntil: "domcontentloaded" },
        { type: "wait", ms: 100 },
        { type: "extractText", label: "page", maxLength: 500 },
        { type: "observe", label: "controls", limit: 10 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const elements = result.data?.observations[0]?.elements ?? [];
    const summary = JSON.stringify({
      finalUrl: result.data?.finalUrl,
      steps: result.data?.steps,
      extractedText: result.data?.extractedText,
      elements: elements.map((element) => ({ tag: element.tag, role: element.role, text: element.text })),
    });
    assert.equal(elements[0]?.text, "Book now", summary);
    assert.ok(elements.some((element) => element.tag === "button" && element.text === "Book now"), summary);
    assert.ok(elements.some((element) => element.tag === "input" && element.text === "Your name" && element.placeholder === "Your name" && element.inputType === "text"), summary);
    assert.ok(elements.some((element) => element.tag === "a" && element.text === "Services" && element.href === `${baseUrl}/services`), summary);
    assert.equal(elements.some((element) => element.tag === "svg" || element.role === "img"), false, summary);
    assert.equal(elements.some((element) => element.text === "Hidden submit"), false, summary);
  });
});

test("browser operate dismissDialogs waits for delayed consent controls", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/delayed-cookie`, waitUntil: "domcontentloaded" },
        { type: "dismissDialogs", timeoutMs: 2000 },
        { type: "extractText", selector: "body", label: "body", maxLength: 500 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.data?.steps[1]?.summary.includes("Allow all"), true, JSON.stringify(result.data?.steps, null, 2));
    assert.equal(result.data?.extractedText[0]?.text.includes("Allow all"), false, result.data?.extractedText[0]?.text);
  });
});

test("browser operate clickVisible does not match short action text inside unrelated words", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/click-matching`, waitUntil: "domcontentloaded" },
        { type: "clickVisible", text: "Book", timeoutMs: 1000 },
        { type: "extractText", selector: "body", label: "body", maxLength: 500 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.data?.steps[1]?.summary.includes('"Book now"'), true, JSON.stringify(result.data?.steps, null, 2));
    assert.equal(result.data?.extractedText[0]?.text.includes("book-clicked"), true, result.data?.extractedText[0]?.text);
    assert.equal(result.data?.extractedText[0]?.text.includes("facebook-clicked"), false, result.data?.extractedText[0]?.text);
  });
});

test("browser operate external-action-safe clickVisible skips provider business CTAs", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/external-action-safe-click`, waitUntil: "domcontentloaded" },
        { type: "clickVisible", text: "Book", timeoutMs: 1000, externalActionSafe: true },
        { type: "extractText", selector: "body", label: "body", maxLength: 500 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.data?.finalUrl, `${baseUrl}/customer-booking`);
    assert.equal(result.data?.steps[1]?.summary.includes('"Book appointment"'), true, JSON.stringify(result.data?.steps, null, 2));
    assert.equal(result.data?.extractedText[0]?.text.includes("Customer booking form"), true, result.data?.extractedText[0]?.text);
  });
});

test("browser operate clickVisible tolerates navigation started by previous click", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/navigate-between-clicks`, waitUntil: "domcontentloaded" },
        { type: "clickVisible", text: "Appointment", timeoutMs: 2000 },
        { type: "clickVisible", text: "Book", timeoutMs: 3000, optional: true },
        { type: "extractText", selector: "body", label: "body", maxLength: 500 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.data?.finalUrl, `${baseUrl}/after-navigation`);
    assert.equal(result.data?.extractedText[0]?.text.includes("after navigation"), true, result.data?.extractedText[0]?.text);
  });
});

test("browser operate semantically fills forms and stops before final submit", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-form`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "appointment-prep",
          valuesText: [
            "Book a haircut appointment.",
            "Dimitrii Test",
            "dimitrii.test@example.com",
            "+34 617 000 111",
            "Friday after 17:00",
            "Please prepare the booking, but do not submit.",
          ].join("\n"),
          allowContinue: true,
          submit: false,
        },
        { type: "extractText", selector: "body", label: "body", maxLength: 1000 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.status, "completed", JSON.stringify(report, null, 2));
    assert.equal(report?.filled.some((field) => /name/i.test(field.field)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.filled.some((field) => /email/i.test(field.field)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.filled.some((field) => /phone/i.test(field.field)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.clicked.some((click) => /continue/i.test(click.text)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.beforeSubmit.some((text) => /book now/i.test(text)), true, JSON.stringify(report, null, 2));
    const body = result.data?.extractedText[0]?.text ?? "";
    assert.match(body, /continued-without-submit/);
    assert.doesNotMatch(body, /submitted-externally/);
  });
});

test("browser operate semantic form fill requires explicit policy consent approval", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-policy`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "policy-safe-prep",
          valuesText: "Test User\ntest@example.com\n+34 600 000 000",
          allowPolicyConsent: false,
        },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.status, "partial", JSON.stringify(report, null, 2));
    assert.equal(report?.checked.length, 0, JSON.stringify(report, null, 2));
    assert.equal(report?.skipped.some((item) => /consent requires explicit approval/i.test(item.reason)), true, JSON.stringify(report, null, 2));
  });
});

test("browser operate semantic form fill skips global provider search fields", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-global-search`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "provider-page-prep",
          valuesText: "Book a haircut appointment.\nTest User\ntest@example.com\n+34 600 000 000",
        },
        { type: "extractText", selector: "body", label: "body", maxLength: 1000 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.filled.some((field) => /services or businesses/i.test(field.field)), false, JSON.stringify(report, null, 2));
    assert.equal(report?.skipped.some((field) => /provider\/directory search/i.test(field.reason)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.filled.some((field) => /email/i.test(field.field)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.filled.some((field) => /phone/i.test(field.field)), true, JSON.stringify(report, null, 2));
    const body = result.data?.extractedText[0]?.text ?? "";
    assert.match(body, /global-search-empty/);
  });
});

test("browser operate semantic form fill continues after a prior prepared field reveals progress", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-progress-after-prep`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "booking-step-prep",
          valuesText: "Book a haircut after 17:00 for Test User test@example.com +34 600 000 000",
          allowContinue: true,
          submit: false,
          maxRounds: 3,
        },
        { type: "extractText", selector: "body", label: "body", maxLength: 1000 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.clicked.some((click) => /continuar/i.test(click.text)), true, JSON.stringify(report, null, 2));
    assert.equal(report?.blockers.some((blocker) => /\bReservar\b/.test(blocker)), false, JSON.stringify(report, null, 2));
    const body = result.data?.extractedText[0]?.text ?? "";
    assert.match(body, /continued-after-prep/);
  });
});

test("browser operate semantic form fill clicks observed safe progress controls outside form button markup", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-observed-progress`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "observed-progress-prep",
          valuesText: "Book a haircut after 17:00 for Test User test@example.com +34 600 000 000",
          allowContinue: true,
          submit: false,
          maxRounds: 3,
        },
        { type: "extractText", selector: "body", label: "body", maxLength: 1000 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.clicked.some((click) => /observed action layer/i.test(click.reason)), true, JSON.stringify(report, null, 2));
    const body = result.data?.extractedText[0]?.text ?? "";
    assert.match(body, /observed-progress-clicked/);
  });
});

test("browser operate semantic form fill stops before account and social login controls", async () => {
  await withTestServer(async (baseUrl) => {
    const result = await runBrowserOperate({
      commands: [
        { type: "navigate", url: `${baseUrl}/semantic-login-boundary`, waitUntil: "domcontentloaded" },
        {
          type: "fillFormSemantically",
          label: "login-boundary-prep",
          valuesText: "Book a haircut after 17:00 for Test User test@example.com +34 600 000 000",
          allowContinue: true,
          submit: false,
          maxRounds: 3,
        },
        { type: "extractText", selector: "body", label: "body", maxLength: 1000 },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const report = result.data?.formFills[0];
    assert.equal(report?.clicked.filter((click) => /continuar/i.test(click.text)).length, 1, JSON.stringify(report, null, 2));
    assert.equal(report?.clicked.some((click) => /facebook|apple/i.test(click.text)), false, JSON.stringify(report, null, 2));
    assert.equal(report?.blockers.some((blocker) => /account\/login/i.test(blocker)), true, JSON.stringify(report, null, 2));
  });
});

async function withTestServer(testBody: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/click-matching") {
      response.end(`
        <html>
          <body>
            <main>
              <a id="facebook" href="#facebook">Facebook</a>
              <a href="/business">Appointment scheduler</a>
              <button id="book">Book now</button>
              <script>
                document.querySelector('#facebook').addEventListener('click', (event) => {
                  event.preventDefault();
                  document.body.insertAdjacentHTML('beforeend', '<p>facebook-clicked</p>');
                });
                document.querySelector('#book').addEventListener('click', () => {
                  document.body.insertAdjacentHTML('beforeend', '<p>book-clicked</p>');
                });
              </script>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/navigate-between-clicks") {
      response.end(`
        <html>
          <body>
            <main>
              <a href="/after-navigation">Appointment scheduler</a>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/external-action-safe-click") {
      response.end(`
        <html>
          <body>
            <main>
              <a href="/for-business">Book</a>
              <a href="/customer-booking">Book appointment</a>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/customer-booking") {
      response.end(`
        <html>
          <body>
            <main>
              <h1>Customer booking form</h1>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/after-navigation") {
      response.end(`
        <html>
          <body>
            <main>
              <p>after navigation</p>
              <button>Book now</button>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/delayed-cookie") {
      response.end(`
        <html>
          <body>
            <main>Booking page</main>
            <script>
              setTimeout(() => {
                const banner = document.createElement('div');
                banner.id = 'consent';
                banner.innerHTML = '<button>Allow all</button>';
                banner.querySelector('button').addEventListener('click', () => banner.remove());
                document.body.appendChild(banner);
              }, 250);
            </script>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-form") {
      response.end(`
        <html>
          <body>
            <main>
              <form id="booking" onsubmit="event.preventDefault(); document.body.insertAdjacentHTML('beforeend', '<p>submitted-externally</p>');">
                <label for="name">Full name *</label>
                <input id="name" name="customer_name" required />
                <label for="email">Email *</label>
                <input id="email" type="email" name="email" required />
                <label for="phone">Phone *</label>
                <input id="phone" name="phone" required />
                <label for="date">Date or time</label>
                <input id="date" name="date_or_time" />
                <label for="notes">Comment</label>
                <textarea id="notes" name="message"></textarea>
                <button type="button" id="continue">Continue</button>
                <button type="submit" id="submit">Book now</button>
              </form>
              <script>
                document.querySelector('#continue').addEventListener('click', () => {
                  document.body.insertAdjacentHTML('beforeend', '<p>continued-without-submit</p>');
                });
              </script>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-global-search") {
      response.end(`
        <html>
          <body>
            <input id="global-search" placeholder="Search services or businesses" />
            <form>
              <label>Email <input name="email" type="email" /></label>
              <label>Phone <input name="phone" type="tel" /></label>
            </form>
            <div id="status">global-search-empty</div>
            <script>
              document.querySelector('#global-search').addEventListener('input', () => {
                document.querySelector('#status').textContent = 'global-search-filled';
              });
            </script>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-progress-after-prep") {
      response.end(`
        <html>
          <body>
            <main>
              <label for="service">Buscar servicio</label>
              <input id="service" aria-label="Buscar servicio" />
              <button type="button">Reservar</button>
              <button type="button" id="continue" style="display:none">Continuar</button>
              <div id="status">waiting</div>
              <script>
                document.querySelector('#service').addEventListener('input', () => {
                  document.querySelector('#continue').style.display = 'block';
                });
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#status').textContent = 'continued-after-prep';
                });
              </script>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-observed-progress") {
      response.end(`
        <html>
          <body>
            <main>
              <label for="service">Service</label>
              <input id="service" name="service" />
              <div id="continue" style="display:none; width: 160px; height: 40px; background: #097;">Continuar</div>
              <div id="status">waiting</div>
              <script>
                document.querySelector('#service').addEventListener('input', () => {
                  document.querySelector('#continue').style.display = 'block';
                });
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#status').textContent = 'observed-progress-clicked';
                });
              </script>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-login-boundary") {
      response.end(`
        <html>
          <body>
            <main>
              <label for="service">Service</label>
              <input id="service" name="service" />
              <button type="button" id="continue" style="display:none">Continuar</button>
              <div id="status">waiting</div>
              <script>
                document.querySelector('#service').addEventListener('input', () => {
                  document.querySelector('#continue').style.display = 'block';
                });
                document.querySelector('#continue').addEventListener('click', () => {
                  document.querySelector('#status').innerHTML =
                    '<button type="button">Continuar con Facebook</button><button type="button">Continuar con Apple</button><p>login-boundary-visible</p>';
                });
              </script>
            </main>
          </body>
        </html>
      `);
      return;
    }
    if (request.url === "/semantic-policy") {
      response.end(`
        <html>
          <body>
            <main>
              <form>
                <label>Name *<input name="name" required /></label>
                <label>Email *<input type="email" name="email" required /></label>
                <label>I agree to the Privacy Policy <input type="checkbox" name="privacy" required /></label>
                <button type="submit">Submit</button>
              </form>
            </main>
          </body>
        </html>
      `);
      return;
    }
    response.end(`
      <html>
        <body>
          <main>
            <svg role="img" aria-label="decorative icon"><path /></svg>
            <a href="/next">Next page</a>
            <a href="/services">Services</a>
            <input name="customer" placeholder="Your name" />
            <button>Book now</button>
            <div aria-hidden="true"><button>Hidden submit</button></div>
            <footer style="margin-top: 9000px"><a href="/blog">Blog</a></footer>
          </main>
        </body>
      </html>
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await testBody(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
