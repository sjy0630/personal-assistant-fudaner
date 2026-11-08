const loadWord = async (event) => {
  if (event.source !== parent || Object.prototype.toString.call(event.data) !== '[object ArrayBuffer]') return;
  window.removeEventListener('message', loadWord);
  try {
    const container = document.getElementById('slides');
    await docx.renderAsync(event.data, container, null, { breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true });
    const fit = () => {
      const page = container.querySelector('section.docx');
      if (page) container.style.zoom = Math.min(1, (innerWidth - 32) / (page.offsetWidth + 60));
    };
    fit();
    window.addEventListener('resize', fit);
    parent.postMessage({type:'preview-ready'}, '*');
  } catch (error) { parent.postMessage({type:'preview-error'}, '*'); }
};
window.addEventListener('message', loadWord);
parent.postMessage({type:'preview-load'}, '*');
