export function htmlPreview(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  document.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta,link,form,input,button,textarea,select,svg,math').forEach((node) => node.remove());
  let omitted = false;
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || /href$/i.test(attribute.name) || ['srcdoc', 'srcset', 'action', 'formaction', 'target', 'ping'].includes(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.hasAttribute('src') && !(element.tagName === 'IMG' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(element.getAttribute('src') ?? ''))) {
      element.removeAttribute('src');
      if (element.tagName === 'IMG') {
        const placeholder = document.createElement('span');
        placeholder.textContent = '[External image omitted]';
        element.replaceWith(placeholder);
      }
      omitted = true;
    }
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';";
  document.head.prepend(policy);
  if (omitted) {
    const notice = document.createElement('p');
    notice.textContent = 'Read-only snapshot. External assets are not loaded.';
    document.body.prepend(notice);
  }
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}
