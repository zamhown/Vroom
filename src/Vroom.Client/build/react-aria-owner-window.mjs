import { fileURLToPath } from 'node:url';

// React Aria 3.53.1 still uses module-global DOM objects in overlay geometry.
// Keep Adobe's flip/scroll/anchor algorithm, but bind DOM operations to the owning window.
// Transform the installed source in dev and production; never mutate node_modules.
const context = fileURLToPath(new URL('../src/window-environment.ts', import.meta.url)).replaceAll('\\', '/');
export function patchOwnerWindow(source, file) {
  let code = source;
  const replace = (pattern, replacement, expected = 1) => {
    const matches = [...code.matchAll(new RegExp(pattern.source, 'g'))];
    if (matches.length !== expected)
      throw Error(`React Aria owner-window patch needs review: ${file}, ${pattern} (${matches.length}/${expected})`);
    code = code.replace(new RegExp(pattern.source, 'g'), replacement);
  };
  const contextScope = /function ([\w$]+)\((props|opts)\) \{/;
  const scopeFromContext = () => {
    code = `import {useWindowDocument as useOverlayOwnerDocument} from ${JSON.stringify(context)};\n` + code;
    replace(
      contextScope,
      '$&\n    const document = useOverlayOwnerDocument();\n    const window = document.defaultView;',
    );
  };
  if (file === 'useOverlayPosition.mjs') {
    let viewport;
    replace(
      /let ([\w$]+\$var\$visualViewport) = typeof document !== 'undefined' \? window.visualViewport : null;/,
      (_, name) => {
        viewport = name;
        return '';
      },
    );
    scopeFromContext();
    replace(/const window = document.defaultView;/, `$&\n    const ${viewport} = window.visualViewport;`);
    replace(/(\$[\w$]+\$var\$useResize)\(updatePosition\);/, '$1(updatePosition, window);');
    replace(/(function [\w$]+\$var\$useResize)\(onResize\)/, '$1(onResize, window)');
    // Scroll anchoring must follow the focused element in this same document.
    const active = code.match(/import \{getActiveElement as ([\w$]+)/)?.[1];
    if (!active) throw Error('React Aria getActiveElement import changed');
    replace(new RegExp(`\\(0, ${active.replaceAll('$', '\\$')}\\)\\(\\)`, 'g'), `(0, ${active})(document)`, 2);
  } else if (file === 'calculatePosition.mjs') {
    replace(
      /let ([\w$]+\$var\$getVisualViewport) = \(\)=>typeof document !== 'undefined' \? window.visualViewport : null;/,
      'let $1 = node => node.ownerDocument.defaultView.visualViewport;',
    );
    replace(/(\$[\w$]+\$var\$getVisualViewport)\(\)/, '$1(overlayNode)');
    const scope = node =>
      `\n    const document = ${node}.ownerDocument, window = document.defaultView, HTMLElement = window.HTMLElement;`;
    replace(/function ([\w$]+)\(opts\) \{/, match => match + scope('opts.overlayNode'));
    replace(
      /function ([\w$]+\$var\$getContainerDimensions)\(containerNode, visualViewport\) \{/,
      match => match + scope('containerNode'),
    );
    replace(
      /function ([\w$]+\$var\$(?:getMargins|getOffset|getPosition|getContainingBlock|isContainingBlock))\(node[^)]*\) \{/,
      match => match + scope('node'),
      5,
    );
  } else if (file === 'useResizeObserver.mjs') {
    replace(/(function [\w$]+\$var\$hasResizeObserver)\(\)/, '$1(window)');
    replace(/if \(!element\) return;/, '$&\n        const window = element.ownerDocument.defaultView;');
    replace(/(\$[\w$]+\$var\$hasResizeObserver)\(\)/, '$1(window)');
  } else if (file === 'useCloseOnScroll.mjs') {
    scopeFromContext();
    replace(
      /const window = document.defaultView;/,
      '$&\n    const {Node, HTMLInputElement, HTMLTextAreaElement} = window;',
    );
  } else return null;
  return code.replace(/\/\/# sourceMappingURL=.*$/m, '');
}

export function reactAriaOwnerWindow() {
  let building = false;
  const patched = new Set();
  return {
    name: 'react-aria-owner-window',
    enforce: 'pre',
    configResolved(config) {
      building = config.command === 'build';
    },
    buildStart() {
      patched.clear();
    },
    buildEnd(error) {
      if (!error && building && patched.size !== 4)
        throw Error('React Aria owner-window module paths changed; review the integration before building.');
    },
    transform(source, id) {
      const match = id
        .split('?')[0]
        .replaceAll('\\', '/')
        .match(
          /\/react-aria\/dist\/private\/(?:overlays|utils)\/(useOverlayPosition|calculatePosition|useResizeObserver|useCloseOnScroll)\.mjs$/,
        );
      if (match) {
        patched.add(match[1]);
        return { code: patchOwnerWindow(source, match[1] + '.mjs'), map: null };
      }
    },
  };
}
