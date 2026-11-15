export function measureContrast(list = null) {
  const rgba = text => { const v = text.match(/[\d.]+/g).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; };
  const over = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (high + 0.05) / (low + 0.05); };
  const backs = element => {
    const chain = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    let bases = [[255, 255, 255]];
    for (const node of chain) {
      const style = getComputedStyle(node);
      const color = rgba(style.backgroundColor);
      if (color[3] > 0) bases = bases.map(base => over(color, base));
      if (style.backgroundImage === "none") continue;
      if (style.backgroundImage.includes("url(")) throw new Error(`An image needs a separate contrast check: ${node.tagName.toLowerCase()}.${node.className}`);
      const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map(match => rgba(match[0]));
      if (stops.length) bases = bases.flatMap(base => stops.map(stop => over(stop, base)));
    }
    return bases;
  };
  const measure = (kind, element) => {
    const style = getComputedStyle(element);
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const color = rgba(style.color), size = parseFloat(style.fontSize);
    const need = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    const worst = Math.min(...backs(element).map(back => ratio(over([...color.slice(0, 3), color[3] * opacity], back), back)));
    return { kind, text: element.textContent.trim().slice(0, 60), ratio: Math.round(worst * 100) / 100, need };
  };
  const edge = (kind, element) => {
    const style = getComputedStyle(element), looks = [rgba(style.backgroundColor)];
    if (parseFloat(style.borderTopWidth) > 0) looks.push(rgba(style.borderTopColor));
    const worst = Math.min(...backs(element.parentElement).map(back => Math.max(...looks.map(look => ratio(over(look, back), back)))));
    return { kind, text: element.textContent.trim().slice(0, 60), ratio: Math.round(worst * 100) / 100, need: 3 };
  };
  const shown = element => element.getClientRects().length && element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !element.closest(".vh");
  if (list) return list.map(([kind, selector, part = "text"]) => {
    const elements = [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length);
    if (!elements.length) throw new Error(`No sample ${kind} ${part}`);
    return elements.map(element => (part === "edge" ? edge : measure)(kind, element));
  });
  return [...document.querySelectorAll("body *")]
    .filter(element => !["SCRIPT", "STYLE", "OPTION"].includes(element.tagName) && !(element instanceof SVGElement) && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && shown(element))
    .map(element => measure(`${element.tagName.toLowerCase()}${element.className ? "." + String(element.className).trim().split(/\s+/).join(".") : ""}`, element));
}
