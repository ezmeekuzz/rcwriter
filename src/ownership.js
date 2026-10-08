// RCWriter is created and owned by Rustom Codilan (https://tomdigitalspace.com/).
// Copyright (c) 2026 Rustom Codilan. All rights reserved. See LICENSE.
//
// The owner's name and website are shown in the app. If they are removed or
// hidden, RCWriter treats the copy as modified: it stops running schedules
// and shows the ownership notice instead of the app.

const OWNER = 'Rustom Codilan';
const WEBSITE = 'https://tomdigitalspace.com/';
const PRODUCT = 'RCWriter';
const COPYRIGHT = `Copyright © 2026 ${OWNER}. All rights reserved.`;
const SIGNATURE = `${PRODUCT} by ${OWNER}`;

// Checked again in main.js and preload.js with encoded copies, so changing one
// place is detected.
const ENCODED = Buffer.from(`${OWNER}|${WEBSITE}`).toString('base64');
const sameIdentity = (encoded) => encoded === ENCODED;

// Runs in the window: the mark must exist, show the owner and website, and be visible.
const RENDERER_CHECK = `(() => {
  const marks = [...document.querySelectorAll('.owner-mark')];
  if (!marks.length) return 'missing';
  const good = marks.filter((el) => (el.textContent || '').includes(${JSON.stringify(OWNER)}) && (el.textContent || '').includes('tomdigitalspace.com'));
  if (!good.length) return 'changed';
  const shown = good.some((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    let p = el; while (p) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.5) return false; p = p.parentElement; }
    return r.width >= 40 && r.height >= 8 && parseFloat(cs.fontSize) >= 9;
  });
  return shown ? 'ok' : 'hidden';
})()`;

module.exports = { OWNER, WEBSITE, PRODUCT, COPYRIGHT, SIGNATURE, ENCODED, sameIdentity, RENDERER_CHECK };
