// Polyfill URL.parse() for older browsers (Safari < 18.2, Chrome < 126)
if (!URL.parse) {
  URL.parse = (url, base) => {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

// Polyfill Promise.try() for older browsers (Safari < 18.2, Chrome < 128)
if (!Promise.try) {
  Promise.try = (fn) => new Promise((resolve) => resolve(fn()));
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
