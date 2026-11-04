// A small line chart drawn as SVG, shared by the pages that have a graph (Macros Tracker, Weight, Reading).
// It draws into an existing <svg viewBox="0 0 360 300"> element and needs no library.

const SVG_NS = "http://www.w3.org/2000/svg";
// Drawing area in SVG units; the SVG scales to the screen width, so 360 is about phone size.
const CHART = { width: 360, height: 300, left: 46, right: 22, top: 14, bottom: 36 };

function svgEl(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [attribute, value] of Object.entries(attributes || {})) {
    element.setAttribute(attribute, value);
  }
  return element;
}

// Picks a round axis step (1, 2, 2.5, 5 x a power of ten) giving about four gridlines.
function niceScale(maxValue, floor) {
  const rough = Math.max(maxValue, floor) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
    .find((candidate) => candidate >= rough);
  return { step: step, bottom: 0, top: step * Math.ceil(Math.max(maxValue, floor) / step) };
}

// Same idea, but the axis starts just under the lowest value instead of at 0. Weights sit
// around 80 and move by a kilo or two, so an axis from 0 would draw a flat line.
function niceZoomScale(minValue, maxValue) {
  const rough = Math.max(maxValue - minValue, 1) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
    .find((candidate) => candidate >= rough);
  const bottom = step * Math.floor(minValue / step);
  const top = step * Math.ceil(maxValue / step);
  return { step: step, bottom: bottom, top: top > bottom ? top : bottom + step };
}

// Splits a series into runs of consecutive days that have a value, so a blank day leaves a
// gap in the line instead of a fake drop to zero.
function runsOf(points) {
  const runs = [];
  let current = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) {
        runs.push(current);
      }
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

// options:
//   labels      one text per day, left to right (the newest day last)
//   series      [{ name, values, tip }]. values has one number (or null for "no data") per day, already
//               scaled to the shared axis; name becomes a CSS class; tip(index) is the hover text
//   emptyMax    the top of the axis to draw while there is no data at all
//   guides      [{ name, value, label, tip }]: faded dotted horizontal lines (for goals), drawn at
//               value on the shared axis. The axis always stretches to include them.
//   minMax      the smallest top the axis may have (default 100), so small numbers are not squashed
//   zoom        true: the axis starts just under the lowest value instead of 0 (minMax is ignored);
//               emptyMin is then the bottom of the axis to draw while there is no data
//   emptyText   the note shown on an empty chart
export function drawLineChart(svg, options) {
  svg.replaceChildren();

  const { labels, series } = options;
  const count = labels.length;
  const allValues = series.flatMap((item) => item.values).filter((value) => value !== null);
  const hasData = allValues.length > 0;

  // With no data the axes are still drawn, on a typical scale, so the graph is visible from
  // day one instead of appearing only after the first entry.
  const floor = options.minMax === undefined ? 100 : options.minMax;
  const guides = options.guides || [];
  const dataTop = hasData ? Math.max(...allValues) : options.emptyMax;
  const highest = Math.max(dataTop, ...guides.map((guide) => guide.value));
  const scale = options.zoom
    ? niceZoomScale(hasData ? Math.min(...allValues) : options.emptyMin, highest)
    : niceScale(highest, floor);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const xAt = (index) => CHART.left + (count === 1 ? plotWidth / 2 : (index * plotWidth) / (count - 1));
  const yAt = (value) => CHART.top + plotHeight - ((value - scale.bottom) / (scale.top - scale.bottom)) * plotHeight;
  const baseline = yAt(scale.bottom);

  // horizontal gridlines with value labels. Counted by index and rounded, so a step like 0.25
  // does not pick up floating-point noise in the labels.
  const lineCount = Math.round((scale.top - scale.bottom) / scale.step);
  for (let lineIndex = 0; lineIndex <= lineCount; lineIndex += 1) {
    const value = Math.round((scale.bottom + lineIndex * scale.step) * 100) / 100;
    const y = yAt(value);
    svg.append(svgEl("line", {
      class: lineIndex === 0 ? "axis" : "grid",
      x1: CHART.left, x2: CHART.width - CHART.right, y1: y, y2: y,
    }));
    const label = svgEl("text", { x: CHART.left - 6, y: y, "text-anchor": "end", dy: "0.35em" });
    label.textContent = String(value);
    svg.append(label);
  }
  svg.append(svgEl("line", {
    class: "axis", x1: CHART.left, x2: CHART.left, y1: CHART.top, y2: baseline,
  }));

  // x labels, counted back from the newest day so it is always labelled
  const labelEvery = Math.ceil(count / 6);
  for (let index = 0; index < count; index += 1) {
    if ((count - 1 - index) % labelEvery !== 0) {
      continue;
    }
    const x = xAt(index);
    svg.append(svgEl("line", { class: "axis", x1: x, x2: x, y1: baseline, y2: baseline + 5 }));
    const label = svgEl("text", { x: x, y: baseline + 19, "text-anchor": "middle" });
    label.textContent = labels[index];
    svg.append(label);
  }

  // goal lines sit behind the data, and show on an empty chart too
  for (const guide of guides) {
    const y = yAt(guide.value);
    const line = svgEl("line", {
      class: "guide " + guide.name,
      x1: CHART.left, x2: CHART.width - CHART.right, y1: y, y2: y,
    });
    const tip = svgEl("title");
    tip.textContent = guide.tip;
    line.append(tip);
    svg.append(line);
  }
  // the labels go on last, on top of the data, so a point never hides them
  const appendGuideLabels = () => {
    for (const guide of guides) {
      const label = svgEl("text", {
        class: "guide-label " + guide.name,
        x: CHART.width - CHART.right - 4, y: yAt(guide.value) - 4, "text-anchor": "end",
      });
      label.textContent = guide.label;
      svg.append(label);
    }
  };

  if (!hasData) {
    const note = svgEl("text", {
      class: "placeholder",
      x: CHART.left + plotWidth / 2, y: CHART.top + plotHeight / 2, "text-anchor": "middle",
    });
    note.textContent = options.emptyText || "No data yet";
    svg.append(note);
    appendGuideLabels();
    return;
  }

  const dotSize = Math.max(4, Math.min(9, (plotWidth / count) * 0.5));
  for (const item of series) {
    const points = item.values.map((value, index) =>
      value === null ? null : { x: xAt(index), y: yAt(value), index: index });

    for (const run of runsOf(points)) {
      if (run.length < 2) {
        continue;
      }
      const path = run.map((point) => point.x + "," + point.y).join(" ");
      svg.append(svgEl("polyline", { class: "line " + item.name, points: path }));
    }

    for (const point of points.filter((candidate) => candidate !== null)) {
      const dot = svgEl("rect", {
        class: "dot " + item.name,
        x: point.x - dotSize / 2, y: point.y - dotSize / 2, width: dotSize, height: dotSize,
      });
      const tip = svgEl("title");
      tip.textContent = item.tip(point.index);
      dot.append(tip);
      svg.append(dot);
    }
  }
  appendGuideLabels();
}
