import { countryLanguage, isLang, type Lang } from "../notifications/noticeLanguage.js";
import { clockTime, SHARE, type PublicShare } from "./tripShare.js";

/**
 * Contract v0.18.116 §94 (contract.json#shareTrip.routes.publicPage): the page behind a shared trip link, rendered by
 * the server from the same allow-list as the JSON (PublicShare). No script (the CSP forbids all of it): the page
 * reloads itself with a meta refresh. No Open Graph / preview tags and a fixed title, so a messaging app's link
 * preview never carries trip data. Every value is escaped: the plate and the car model are typed by drivers.
 */

export type SharePage = { kind: "live"; view: PublicShare; timeZone: string } | { kind: "searching"; refreshSeconds: number } | { kind: "ended" } | { kind: "not_found" } | { kind: "too_many" };

/** contract.json#shareTrip.language: the viewer's Accept-Language (first of sv / fr / en), else the zone's country, else en. */
export function pageLanguage(acceptLanguage: string | undefined, country: string | null): Lang {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const two = part.split(";")[0]!.trim().slice(0, 2).toLowerCase();
    if (isLang(two)) return two;
  }
  return countryLanguage(country) ?? "en";
}

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE =
  "body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#14171a}" +
  "main{max-width:28rem;margin:0 auto;padding:1.5rem 1rem}h1{font-size:1.1rem;margin:0 0 1rem}" +
  ".card{background:#fff;border-radius:12px;padding:1rem 1.25rem;margin:0 0 1rem}.phase{font-size:1.3rem;font-weight:600;margin:0}" +
  ".eta{margin:.25rem 0 0}dl{margin:0}dt{font-size:.8rem;color:#5b6570}dd{margin:0 0 .5rem;font-weight:600}" +
  ".plate{font-size:1.4rem;letter-spacing:.05em}.map{display:block;text-align:center;background:#14171a;color:#fff;" +
  "padding:.8rem;border-radius:12px;text-decoration:none;font-weight:600}.small{font-size:.8rem;color:#5b6570}";

export function renderSharePage(lang: Lang, page: SharePage): string {
  const t = SHARE.texts[lang];
  const e = escapeHtml;
  const say = (key: string, values: Record<string, string> = {}) => e(Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t[key] ?? ""));
  let body: string;
  if (page.kind === "live") {
    const v = page.view;
    const queued = v.phase === SHARE.public.queuedPhase;
    const phase = say(queued ? "queued" : v.phase === "to_pickup" ? "toPickup" : v.phase === "at_pickup" ? "atPickup" : "onTrip");
    const eta = v.eta ? `<p class="eta">${say("arriving", { min: String(v.eta.minutes) })} · ${say("around", { time: v.eta.arriveAround })}</p>` : "";
    const car = [v.car.color, v.car.make, v.car.model].filter((part) => part !== "").join(" ");
    const position = v.position
      ? `<p><a class="map" rel="noopener noreferrer" href="${e(SHARE.public.positionLink.replace("{lat}", String(v.position.lat)).replace("{lng}", String(v.position.lng)))}">${say("openInMaps")}</a></p>`
      : queued
        ? ""
        : `<p class="small">${say("noPosition")}</p>`;
    body =
      `<div class="card"><p class="phase">${phase}</p>${eta}</div>` +
      `<div class="card"><dl><dt>${say("car")}</dt><dd>${e(car)}</dd><dt>${say("plate")}</dt><dd class="plate">${e(v.car.plate)}</dd></dl></div>` +
      position +
      `<p class="small">${say("updated", { time: clockTime(new Date(v.updatedAt), page.timeZone) })}</p>` +
      `<p class="small">${say("privacy")}</p>`;
  } else {
    body = `<div class="card"><p${page.kind === "searching" ? ' class="phase"' : ""}>${say(page.kind === "searching" ? "searching" : page.kind === "ended" ? "ended" : page.kind === "not_found" ? "notFound" : "tooMany")}</p></div>`;
  }
  const seconds = page.kind === "live" ? page.view.refreshSeconds : page.kind === "searching" ? page.refreshSeconds : null;
  const refresh = seconds !== null ? `<meta http-equiv="refresh" content="${seconds}">` : "";
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">${refresh}` +
    `<title>Movera · ${say("title")}</title><style>${STYLE}</style></head><body><main><h1>Movera</h1>${body}</main></body></html>`
  );
}
