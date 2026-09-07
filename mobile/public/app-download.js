// SPDX-License-Identifier: Apache-2.0
fetch('/release-manifest.json', { cache: 'no-store' })
  .then((response) => {
    if (!response.ok) throw new Error('manifest unavailable');
    return response.json();
  })
  .then((manifest) => {
    if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error('invalid manifest');
    }
    document.getElementById('web-version').textContent = `Weft ${manifest.version}`;
    const apkName = `weft-${manifest.version}.apk`;
    const apk = manifest.files && manifest.files[apkName];
    if (!apk) return;
    if (!Number.isSafeInteger(apk.bytes) || apk.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(apk.sha256)) {
      throw new Error('invalid APK metadata');
    }
    const link = document.getElementById('apk-link');
    link.href = `/${apkName}`;
    link.download = apkName;
    document.getElementById('apk-version').textContent = `dev.aasis21.weft · v${manifest.version}`;
    document.getElementById('apk-size').textContent = `${(apk.bytes / 1024 / 1024).toFixed(1)} MB`;
    document.getElementById('apk-sha').textContent = apk.sha256;
    document.getElementById('native-card').hidden = false;
  })
  .catch(() => {
    document.getElementById('web-version').textContent = 'Current release';
  });
