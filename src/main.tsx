import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/source-serif-pro/400.css';
import '@fontsource/source-serif-pro/600.css';
import '@fontsource/work-sans/400.css';
import '@fontsource/work-sans/500.css';
import '@fontsource/work-sans/600.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './app/App';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
