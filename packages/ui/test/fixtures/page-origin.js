// AIT-625 r3: happy-dom 21 has no window.origin; every browser has it. The owner-request helper
// (and the voice relay guard) read window.origin and fail closed without it, so element tests on a
// happy-dom page sent nothing and waited forever. This gives happy-dom windows the browser value for
// a non-sandboxed document: the serialized origin of its URL ("null" for about:blank, so those
// pages still fail closed). Like the browser attribute it is [Replaceable]: assigning it shadows it.
import { BrowserWindow } from 'happy-dom';

if (!Object.getOwnPropertyDescriptor(BrowserWindow.prototype, 'origin')) {
  Object.defineProperty(BrowserWindow.prototype, 'origin', {
    configurable: true,
    get() { return this.location.origin; },
    set(value) { Object.defineProperty(this, 'origin', { configurable: true, enumerable: true, writable: true, value }); },
  });
}
