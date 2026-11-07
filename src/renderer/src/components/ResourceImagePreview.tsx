import { useEffect, useState } from 'react';
import type { ResourceImage } from '../../../shared/types';
import { api } from '../api';

export function ResourceImagePreview({ id, title }: { id: string; title: string }) {
  const [image, setImage] = useState<ResourceImage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setImage(null); setError(false);
    void api.library.image(id).then((result) => {
      if (active) { setImage(result); setError(!result); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id, retry]);
  if (error) return <p role="alert">无法读取图片，请重试或重新上传。<button type="button" onClick={() => setRetry((count) => count + 1)}>重试</button></p>;
  if (!image) return <p role="status">正在加载图片…</p>;
  return <figure className="resource-image-preview"><img src={image.dataUrl} alt={title} onError={() => setError(true)} /><figcaption className="muted small">{image.width} × {image.height} 像素 · 引用到对话后，需要支持图片的模型阅读。</figcaption></figure>;
}
