import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_SOURCE_MANIFEST = 'packaging/release-source.json';
const privateDirectories = new Set(['.git', '.runtime', '.local-data', '.agents', '.codex', '.ssh', '.aws', 'state', 'logs', 'node_modules', 'runtime', 'research']);
const credentialNames = new Set(['.npmrc', 'ave-credentials.json', 'gmgn-api-key', 'telegram-bot-token', 'agent-private-key', 'gmgn-pending-signing-key.pem']);

export function privateSourcePath(name) {
  return String(name).split('/').some(segment => {
    const part = segment.toLowerCase();
    return privateDirectories.has(part) || credentialNames.has(part) || /^\.env(?:\.|$)/.test(part)
      || /\.(?:key|pem|p12|pfx|keystore|jks|bak|tmp|log|swp|orig)$/.test(part) || part.endsWith('~');
  });
}

function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 500 || name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function approvedSourceFile(root, name) {
  if (!safeName(name) || privateSourcePath(name)) throw new Error(`发布白名单含不安全或私密路径：${name}`);
  let current = root;
  for (const part of ['', ...name.split('/').slice(0, -1)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`发布白名单不允许符号链接目录：${name}`);
  }
  const file = path.join(root, ...name.split('/'));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`发布白名单文件不是唯一的普通文件：${name}`);
  return { file, stat };
}

export function releaseSourceNames(root) {
  const { file, stat } = approvedSourceFile(root, RELEASE_SOURCE_MANIFEST);
  if (stat.size > 262144) throw new Error('发布白名单过大');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('发布白名单不是有效 JSON'); }
  if (value?.schema !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > 20000) throw new Error('发布白名单结构无效');
  const keys = new Set();
  for (const name of value.files) {
    if (!safeName(name) || privateSourcePath(name)) throw new Error(`发布白名单含不安全或私密路径：${name}`);
    const key = name.normalize('NFC').toLowerCase();
    if (keys.has(key)) throw new Error(`发布白名单有重复或大小写冲突：${name}`);
    keys.add(key);
  }
  if (!value.files.includes(RELEASE_SOURCE_MANIFEST)) throw new Error('发布白名单必须包含自身');
  return [...value.files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function assertProductionListed(root, names) {
  const allowed = new Set(names);
  const visit = (directory, relative) => {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`发布代码目录不安全：${relative}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (privateSourcePath(name) || entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) throw new Error(`发布代码不允许符号链接：${name}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name);
      else if (/\.(?:[cm]?js|html|css|sh)$/.test(entry.name) && !allowed.has(name)) {
        throw new Error(`代码未加入发布白名单：${name}`);
      }
    }
  };
  for (const directory of ['src', 'scripts', 'public']) visit(path.join(root, directory), directory);
}
