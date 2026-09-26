import DOMPurify from "dompurify";

export function postProps(post) {
  // ruleid: sekhemet.js-dangerously-set-inner-html
  return { className: "post", dangerouslySetInnerHTML: { __html: post.body } };
}

export function bannerProps(text) {
  // ruleid: sekhemet.js-dangerously-set-inner-html
  const props = { dangerouslySetInnerHTML: { __html: `<p>${text}</p>` } };
  return props;
}

export function safeProps(post) {
  // ok: sekhemet.js-dangerously-set-inner-html
  const clean = { dangerouslySetInnerHTML: { __html: DOMPurify.sanitize(post.body) } };
  // ok: sekhemet.js-dangerously-set-inner-html
  const divider = { dangerouslySetInnerHTML: { __html: "<br />" } };
  return [clean, divider];
}
