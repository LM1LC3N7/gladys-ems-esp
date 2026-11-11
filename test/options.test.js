// -----------------------------------------------------------------------------
// The supported_options published follow the core's rules (a single error
// rejects the whole Discovery list): label a plain non-empty text without
// spaces around, value an integer or a string (text/select), unique values,
// no other key. The SDK's fake Gladys does not check this: here the core's own
// validator runs when a Gladys clone is at hand, and the same rules by hand.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { setup } from './helpers/app.js';
import { modeOptions } from '../src/devices.js';

const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

for (const language of ['fr', 'en']) {
  test(`every supported_options published passes the core's rules (${language})`, async () => {
    const t = await setup({
      config: { ...(await import('./fixtures/emsesp.js')).CONFIG, language },
    });
    await t.connect();
    const features = t.gladys.fake.discoveredDevices.flatMap((d) => d.features);
    const withOptions = features.filter((f) => f.supported_options !== undefined);
    assert.ok(withOptions.length >= 1);
    for (const feature of withOptions) {
      const options = feature.supported_options;
      assert.ok(Array.isArray(options) && options.length > 0, feature.external_id);
      const isSelect = feature.category === 'text' && feature.type === 'select';
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(
          Object.keys(option).filter((k) => !['value', 'label', 'sort_order'].includes(k)),
          [],
        );
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0);
        assert.equal(option.label, option.label.trim(), 'no space around the label');
        assert.ok(
          Number.isInteger(option.value) ||
            (isSelect && typeof option.value === 'string' && option.value.trim() !== ''),
          `value ${option.value}`,
        );
        assert.ok(!values.has(String(option.value)), 'unique values');
        values.add(String(option.value));
        if (option.sort_order !== undefined) {
          assert.ok(Number.isInteger(option.sort_order));
        }
      }
      if (normalizeSupportedOptions) {
        assert.deepEqual(
          normalizeSupportedOptions(options, { allowStringValues: isSelect }),
          options,
        );
      }
    }
  });
}

test('mode options of any list EMS-ESP gives pass the same rules (duplicates, unknown modes)', () => {
  for (const language of ['fr', 'en']) {
    const options = modeOptions(
      ['off', 'Off', 'on', 'eco+', 'own prog', 'own prog', 'manuell', '', 'auto', 'a\u0001b'],
      language,
    );
    assert.deepEqual(
      options.map((o) => o.value),
      ['off', 'Off', 'on', 'eco+', 'own prog', 'manuell', 'auto'],
    );
    const labels = options.map((o) => o.label);
    assert.equal(new Set(labels).size, labels.length, 'unique labels');
    for (const label of labels) {
      assert.ok(label.length > 0 && label === label.trim());
    }
    if (normalizeSupportedOptions) {
      assert.deepEqual(normalizeSupportedOptions(options, { allowStringValues: true }), options);
    }
  }
});
