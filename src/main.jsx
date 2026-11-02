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
import ActionLogs from './ActionLogs';
import './styles.css';
import 'katex/dist/katex.min.css';

const pathname = window.location.pathname.replace(/\/+$/, '');
const logsPath = `${import.meta.env.BASE_URL}logs`;
const logUser = pathname.startsWith(`${logsPath}/`) ? pathname.slice(logsPath.length + 1) : '';
const isLogsPage = pathname === logsPath || (logUser && !logUser.includes('/'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isLogsPage ? <ActionLogs targetUser={logUser} /> : <App />}
  </React.StrictMode>
);
