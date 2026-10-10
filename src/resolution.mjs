import { ControllerError } from './errors.mjs';
function unique(entries, label) {
  if (entries.length !== 1) throw new ControllerError('RESOLUTION', `${label}: ${entries.length ? 'mehrdeutig' : 'nicht gefunden'}.`, { matches: entries.map(e => e.id ?? e.instanceId ?? e.slug) });
  return entries[0];
}
export function resolveProject(entries, name) {
  const exactId = entries.filter(p => p.id === name);
  return unique(exactId.length ? exactId : entries.filter(p => p.name === name), 'Projekt');
}
export function resolveProvider(entries, name) {
  const exactId = entries.filter(p => p.instanceId === name);
  const provider = unique(exactId.length ? exactId : entries.filter(p => p.driver === name || p.displayName === name), 'Provider');
  if (!provider.enabled || !provider.installed || provider.availability === 'unavailable' || provider.status !== 'ready' || provider.authStatus === 'unauthenticated') {
    throw new ControllerError('RESOLUTION', 'Provider ist nicht einsatzbereit.', { instanceId: provider.instanceId, status: provider.status });
  }
  return provider;
}
export function resolveModel(provider, name) {
  const models = provider.models ?? [];
  const exact = models.filter(m => m.slug === name);
  return unique(exact.length ? exact : models.filter(m => m.name === name || m.aliases?.includes(name)), 'Modell');
}
export function resolveOptions(model, values = []) {
  const result = [], seen = new Set();
  for (const raw of values) {
    const separator = raw.indexOf('=');
    const id = raw.slice(0, separator), value = raw.slice(separator + 1);
    const descriptor = model.capabilities?.optionDescriptors?.find(d => d.id === id);
    if (separator < 1 || seen.has(id) || !descriptor || (descriptor.type === 'boolean' ? !['true', 'false'].includes(value) : !descriptor.options?.some(option => option.id === value))) {
      throw new ControllerError('RESOLUTION', 'Ungültige oder doppelte Modelloption.', { optionId: separator < 1 ? null : id });
    }
    seen.add(id);
    result.push({ id, value: descriptor.type === 'boolean' ? value === 'true' : value });
  }
  return result;
}
