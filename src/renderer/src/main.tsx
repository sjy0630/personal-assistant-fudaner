import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './theme/warm-songti.css';
// 启动时就按用户选择（或系统）写入 data-theme，暖色主题的深浅色依赖它
import './theme';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
