import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element.');
}

// StrictMode double-invokes effects in development. App's load effect guards against
// this with its `cancelled` flag, and RunStream.start() is itself a safe no-op while
// already running, so this never opens a second connection.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
