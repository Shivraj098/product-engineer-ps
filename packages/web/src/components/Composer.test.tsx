import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

function renderComposer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(
    <Composer
      disabled={false}
      onSend={onSend}
      error={undefined}
      value=""
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onSend, onChange };
}

describe('Composer', () => {
  it('sends the trimmed message and clears the box', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onChange = vi.fn();
    render(
      <Composer
        disabled={false}
        onSend={onSend}
        error={undefined}
        value="  hi there  "
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('hi there');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('disables Send for an empty or whitespace-only message', () => {
    renderComposer({ value: '   ' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables the whole composer while a reply is in progress', () => {
    renderComposer({ disabled: true, value: 'hello' });
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends on Enter but not on Shift+Enter', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ value: 'hello' });

    await user.type(screen.getByRole('textbox'), '{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('shows a server-side error message', () => {
    renderComposer({ error: 'A reply is still being generated for this conversation.' });
    expect(screen.getByRole('alert')).toHaveTextContent('A reply is still being generated');
  });
});
