// Numbers in the monospace face, words in the text face. The visual system
// sets every number that changes or sits in a column in IBM Plex Mono (Albert
// Sans has no tabular figures), but a whole phrase in mono reads wide and
// loose. This wraps each number run in a text node ("62%", "$12.40", "2h",
// "14:12", "5x") in <span class="num"> and leaves the words around it alone.

const NUMBER = /[+\-−]?\$?\d[\d.,:]*(?:%|[dhmx](?![A-Za-z]))?/g;

export function monoNumbers(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(".num, script, style, input")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const text = node.data;
    NUMBER.lastIndex = 0;
    if (!NUMBER.test(text)) continue;
    NUMBER.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(NUMBER)) {
      const at = m.index ?? 0;
      if (at > last) frag.append(text.slice(last, at));
      const span = document.createElement("span");
      span.className = "num";
      span.textContent = m[0];
      frag.append(span);
      last = at + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
