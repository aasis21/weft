// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/ui/styles/styles.css';
import '@/ui/styles/chat.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
