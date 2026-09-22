import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// jsdom's `document` is shared across tests in one file; without this, elements from an
// earlier test (e.g. an earlier render's "Send" button) are still in the DOM for the next.
afterEach(() => cleanup());
