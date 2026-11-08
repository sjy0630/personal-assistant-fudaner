const loadPresentation = async (event) => {
  if (event.source !== parent || Object.prototype.toString.call(event.data) !== '[object ArrayBuffer]') return;
  window.removeEventListener('message', loadPresentation);
  try {
    const viewer = pptxPreview.init(document.getElementById('slides'), { width: Math.max(320, innerWidth - 48), height: Math.max(240, (innerWidth - 48) * 9 / 16), mode: 'slide' });
    await viewer.preview(event.data);
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:16px;align-items:center;justify-content:center;padding:12px;background:white;color:#222';
    const previous = document.createElement('button');
    previous.textContent = '上一页';
    const counter = document.createElement('span');
    const next = document.createElement('button');
    next.textContent = '下一页';
    const update = () => { counter.textContent = `${viewer.currentIndex + 1} / ${viewer.slideCount}`; };
    previous.onclick = () => { viewer.renderPreSlide(); update(); };
    next.onclick = () => { viewer.renderNextSlide(); update(); };
    update();
    controls.append(previous, counter, next);
    document.body.insertBefore(controls, document.getElementById('slides'));
    document.querySelectorAll('.pptx-preview-wrapper-next,.pptx-preview-wrapper-pagination').forEach((element) => { element.style.display = 'none'; });
    parent.postMessage({type:'preview-ready'}, '*');
  } catch (error) { parent.postMessage({type:'preview-error'}, '*'); }
};
window.addEventListener('message', loadPresentation);
parent.postMessage({type:'preview-load'}, '*');
