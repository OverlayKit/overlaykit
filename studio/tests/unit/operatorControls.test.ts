// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductionControl } from '@overlaykit/protocol';
import { OperatorControls } from '@overlaykit/ui';

const mounted: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
});

describe('OperatorControls', () => {
  it('renders only the declared catalog and emits a typed Preview batch', async () => {
    const apply = vi.fn();
    const controls: ProductionControl[] = [
      {
        id: 'title.text',
        label: 'Title',
        type: 'text',
        path: 'title',
        componentId: 'lower-third',
        componentLabel: 'Lower third',
        value: 'Hello',
      },
      {
        id: 'title.visible',
        label: 'Visible',
        type: 'toggle',
        path: 'flags.title',
        componentId: 'lower-third',
        componentLabel: 'Lower third',
        value: true,
      },
    ];
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(OperatorControls, { controls, onApply: apply });
    mounted.push(app);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('Lower third');
    expect(host.textContent).toContain('2 declared');
    expect(host.textContent).not.toContain('flags.title');

    const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = 'Ready';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const applyButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Apply to Preview'))!;
    applyButton.click();
    await nextTick();

    expect(apply).toHaveBeenCalledWith({ 'title.text': 'Ready' });
  });

  it('shows an explicit empty state instead of inferring variables', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(OperatorControls, { controls: [] });
    mounted.push(app);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('no declared controls');
    expect(host.querySelector('input')).toBeNull();
  });
});
