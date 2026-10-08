// Sets the Windows .exe icon and version details without needing Wine,
// so the installer can be built on any operating system.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const { productFilename } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const version = context.packager.appInfo.version;
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, icon.icons.map((i) => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [ma, mi, pa] = version.split('.').map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(ma, mi, pa, 0, 1033);
  vi.setProductVersion(ma, mi, pa, 0, 1033);
  const langs = vi.getAllLanguagesForStringValues();
  const target = langs.length ? langs[0] : { lang: 1033, codepage: 1200 };
  vi.setStringValues(target, {
    FileDescription: 'RCWriter by Rustom Codilan',
    ProductName: 'RCWriter',
    CompanyName: 'Rustom Codilan',
    InternalName: 'RCWriter',
    OriginalFilename: `${productFilename}.exe`,
    FileVersion: version,
    ProductVersion: version,
    LegalCopyright: 'Copyright © 2026 Rustom Codilan. All rights reserved. https://tomdigitalspace.com/'
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • set icon and version info on ${path.basename(exePath)}`);
};
