/**
 * Standalone HTML visualization of the knowledge graph.
 *
 * For graphs with <= 200 nodes: renders every node with D3.js force layout.
 * For larger graphs: auto-aggregates to community view (one circle per community).
 * Supports zoom, pan, drag, search, and tooltips.
 */

import type { KnowledgeGraph } from "./graph.ts";

const D3_JS = "https://d3js.org/d3.v7.min.js";
const COMMUNITY_THRESHOLD = 200;

export function generateHtml(kg: KnowledgeGraph, title: string = "Mind Place"): string {
  const totalNodes = [...kg.nodes.values()].filter(n => n.type !== "file").length;

  if (totalNodes > COMMUNITY_THRESHOLD) {
    return communityHtml(kg, title, totalNodes);
  }
  return fullGraphHtml(kg, title);
}

// ── Community-aggregated view for large graphs ──────────────────────────────

function communityHtml(kg: KnowledgeGraph, title: string, totalNodes: number): string {
  // Aggregate: one node per community
  const commMap = new Map<number, { size: number; label: string; topLabels: string[] }>();
  for (const node of kg.nodes.values()) {
    if (node.type === "file" || node.community === undefined) continue;
    const c = commMap.get(node.community) ?? { size: 0, label: "", topLabels: [] };
    c.size++;
    if (c.topLabels.length < 3) c.topLabels.push(node.label);
    c.label = `Community ${c.topLabels.slice(0, 2).join(", ")}`;
    commMap.set(node.community, c);
  }

  const commNodes = [...commMap.entries()].map(([id, info]) => ({
    id: `c${id}`,
    label: info.label,
    size: info.size,
    topLabels: info.topLabels,
  }));

  // Cross-community edges
  const crossEdges = new Map<string, number>();
  for (const edge of kg.edges) {
    const sn = kg.nodes.get(edge.source);
    const tn = kg.nodes.get(edge.target);
    if (!sn || !tn || sn.type === "file" || tn.type === "file") continue;
    if (sn.community === undefined || tn.community === undefined) continue;
    if (sn.community === tn.community) continue;
    const key = `c${Math.min(sn.community, tn.community)}-c${Math.max(sn.community, tn.community)}`;
    crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
  }

  const commLinks = [...crossEdges.entries()].map(([key, count]) => {
    const [a, b] = key.split("-");
    return { source: a, target: b, count };
  });

  const colors = ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860", "#DA8BC3", "#8C8C8C", "#CCB974", "#64B5CD"];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - Mind Place (Community View)</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;overflow:hidden}
#graph{width:100vw;height:100vh}
.links line{stroke:#444;stroke-opacity:.3;stroke-width:1px}
.nodes circle{stroke:#1a1a2e;stroke-width:2px;cursor:pointer}
.node-label{font-size:11px;fill:#ccc;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.9)}
.node-sublabel{font-size:9px;fill:#999;pointer-events:none}
#tooltip{position:absolute;background:#2a2a3e;border:1px solid #555;border-radius:6px;padding:10px 14px;font-size:13px;pointer-events:none;opacity:0;transition:opacity .15s;max-width:300px;z-index:10}
#tooltip strong{color:#fff}
#tooltip .count{color:#6af;font-size:11px}
#info{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:#2a2a3ecc;border-radius:8px;padding:8px 16px;font-size:12px;backdrop-filter:blur(8px);color:#888}
#search{position:absolute;top:12px;left:12px;z-index:5}
#search input{background:#2a2a3ecc;border:1px solid #555;border-radius:8px;padding:8px 14px;color:#fff;font-size:13px;width:220px;backdrop-filter:blur(8px);outline:none}
#search input:focus{border-color:#6af}
</style>
</head>
<body>
<div id="graph"></div>
<div id="tooltip"></div>
<div id="info">${totalNodes} nodes aggregated into ${commNodes.length} communities - scroll to zoom, drag to pan</div>
<div id="search"><input type="text" placeholder="Search communities..." id="searchInput"></div>
<script src="${D3_JS}"></script>
<script>
const data = { nodes: ${JSON.stringify(commNodes)}, links: ${JSON.stringify(commLinks)} };
const colors = ${JSON.stringify(colors)};
const w = window.innerWidth, h = window.innerHeight;

const svg = d3.select("#graph").append("svg").attr("width","100%").attr("height","100%");
const g = svg.append("g");

const zoom = d3.zoom().scaleExtent([0.1,8]).on("zoom", (e) => g.attr("transform", e.transform));
svg.call(zoom);

const link = g.append("g").attr("class","links").selectAll("line").data(data.links).join("line")
  .attr("stroke-width", d => Math.max(1, Math.min(6, d.count / 2)));

const node = g.append("g").attr("class","nodes").selectAll("circle").data(data.nodes).join("circle")
  .attr("r", d => Math.max(10, Math.min(60, Math.sqrt(d.size) * 3)))
  .attr("fill", d => colors[d.id.charCodeAt(1) % colors.length])
  .call(d3.drag().on("start", (e,d) => { if(!e.active) sim.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
                    .on("drag", (e,d) => { d.fx=e.x; d.fy=e.y; })
                    .on("end", (e,d) => { if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

const label = g.append("g").selectAll("text.main").data(data.nodes).join("text")
  .attr("class","node-label").text(d => d.label.length > 28 ? d.label.slice(0,26)+".." : d.label)
  .attr("text-anchor","middle").attr("dy",-8);

const sublabel = g.append("g").selectAll("text.sub").data(data.nodes).join("text")
  .attr("class","node-sublabel").text(d => d.size + " items").attr("text-anchor","middle").attr("dy",10);

const tip = d3.select("#tooltip");
node.on("mouseover", (e,d) => {
  tip.style("opacity",1).html("<strong>"+d.label+"</strong><br><span class='count'>"+d.size+" entities</span><br>"+d.topLabels.slice(0,5).join("<br>"))
     .style("left",(e.pageX+12)+"px").style("top",(e.pageY-28)+"px");
}).on("mouseout", () => tip.style("opacity",0));

const sim = d3.forceSimulation(data.nodes)
  .force("link", d3.forceLink(data.links).id(d => d.id).distance(150))
  .force("charge", d3.forceManyBody().strength(-400))
  .force("center", d3.forceCenter(w/2, h/2))
  .force("collide", d3.forceCollide(d => Math.max(15, Math.sqrt(d.size)*3 + 5)))
  .on("tick", () => {
    link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
    node.attr("cx",d=>d.x).attr("cy",d=>d.y);
    label.attr("x",d=>d.x).attr("y",d=>d.y);
    sublabel.attr("x",d=>d.x).attr("y",d=>d.y);
  });

d3.select("#searchInput").on("input", function() {
  const q = this.value.toLowerCase();
  node.attr("opacity", d => d.label.toLowerCase().includes(q) || !q ? 1 : .15)
      .attr("r", d => d.label.toLowerCase().includes(q) && q ? Math.max(12, Math.min(70, Math.sqrt(d.size)*3.5)) : Math.max(10, Math.min(60, Math.sqrt(d.size)*3)));
  label.attr("opacity", d => d.label.toLowerCase().includes(q) || !q ? 1 : .15);
  sublabel.attr("opacity", d => d.label.toLowerCase().includes(q) || !q ? 1 : .15);
});

// Auto-zoom to fit
setTimeout(() => {
  const b = g.node().getBBox();
  const dx = b.width, dy = b.height, x = b.x + dx/2, y = b.y + dy/2;
  const scale = Math.min(.8, Math.min(w/(dx+100), h/(dy+100)));
  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(w/2-scale*x, h/2-scale*y).scale(scale));
}, 2000);
</script>
</body>
</html>`;
}

// ── Full graph view for smaller graphs ─────────────────────────────────────

function fullGraphHtml(kg: KnowledgeGraph, title: string): string {
  const nodesArr: Array<{ id: string; label: string; type: string; community: number; degree: number; file: string }> = [];
  for (const node of kg.nodes.values()) {
    if (node.type === "file") continue;
    nodesArr.push({
      id: node.id, label: node.label, type: node.type,
      community: node.community ?? 0,
      degree: kg.adjacency.get(node.id)?.size ?? 0,
      file: node.sourceFile,
    });
  }

  const linkArr: Array<{ source: string; target: string; relation: string }> = [];
  for (const edge of kg.edges) {
    if (kg.nodes.get(edge.source)?.type === "file") continue;
    if (kg.nodes.get(edge.target)?.type === "file") continue;
    linkArr.push({ source: edge.source, target: edge.target, relation: edge.relation });
  }

  const colors = ["#4C72B0","#DD8452","#55A868","#C44E52","#8172B3","#937860","#DA8BC3","#8C8C8C","#CCB974","#64B5CD"];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - Mind Place</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;overflow:hidden}
#graph{width:100vw;height:100vh}
.links line{stroke:#444;stroke-opacity:.3;stroke-width:1px}
.nodes circle{stroke:#1a1a2e;stroke-width:1.5px;cursor:pointer}
.node-label{font-size:10px;fill:#ccc;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.8)}
#tooltip{position:absolute;background:#2a2a3e;border:1px solid #555;border-radius:6px;padding:10px 14px;font-size:13px;pointer-events:none;opacity:0;transition:opacity .15s;max-width:300px;z-index:10}
#tooltip strong{color:#fff}
#tooltip .type{color:#888;font-size:11px}
#tooltip .file{color:#6af;font-size:11px;font-family:monospace}
#legend{position:absolute;top:12px;right:12px;background:#2a2a3ecc;border-radius:8px;padding:10px 14px;font-size:12px;backdrop-filter:blur(8px)}
.legend-item{display:flex;align-items:center;gap:6px;margin:3px 0}
.legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
#search{position:absolute;top:12px;left:12px;z-index:5}
#search input{background:#2a2a3ecc;border:1px solid #555;border-radius:8px;padding:8px 14px;color:#fff;font-size:13px;width:220px;backdrop-filter:blur(8px);outline:none}
#search input:focus{border-color:#6af}
</style>
</head>
<body>
<div id="graph"></div>
<div id="tooltip"></div>
<div id="search"><input type="text" placeholder="Search nodes..." id="searchInput"></div>
<div id="legend"></div>
<script src="${D3_JS}"></script>
<script>
const data = { nodes: ${JSON.stringify(nodesArr)}, links: ${JSON.stringify(linkArr)} };
const colors = ${JSON.stringify(colors)};
const w = window.innerWidth, h = window.innerHeight;

const svg = d3.select("#graph").append("svg").attr("width","100%").attr("height","100%");
const g = svg.append("g");
const zoom = d3.zoom().scaleExtent([0.1,8]).on("zoom", (e) => g.attr("transform", e.transform));
svg.call(zoom);

const types = [...new Set(data.nodes.map(n => n.type))];
const legend = d3.select("#legend");
types.forEach((t,i) => { legend.append("div").attr("class","legend-item").append("div").attr("class","legend-dot").style("background",colors[i%colors.length]); legend.selectAll(".legend-item").filter((_,j)=>j===i).append("span").text(t); });

const link = g.append("g").attr("class","links").selectAll("line").data(data.links).join("line");

const node = g.append("g").attr("class","nodes").selectAll("circle").data(data.nodes).join("circle")
  .attr("r", d => Math.max(3, Math.min(15, d.degree * 2)))
  .attr("fill", d => colors[d.community % colors.length])
  .call(d3.drag().on("start", (e,d) => { if(!e.active) sim.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
                    .on("drag", (e,d) => { d.fx=e.x; d.fy=e.y; })
                    .on("end", (e,d) => { if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

const label = g.append("g").selectAll("text").data(data.nodes).join("text")
  .attr("class","node-label").text(d => d.label.length > 20 ? d.label.slice(0,18)+".." : d.label)
  .attr("dx",8).attr("dy",4);

const tip = d3.select("#tooltip");
node.on("mouseover", (e,d) => {
  tip.style("opacity",1).html("<strong>"+d.label+"</strong> <span class='type'>"+d.type+"</span><br><span class='file'>"+d.file+"</span><br>Connections: "+d.degree)
     .style("left",(e.pageX+12)+"px").style("top",(e.pageY-28)+"px");
}).on("mouseout", () => tip.style("opacity",0));

const sim = d3.forceSimulation(data.nodes)
  .force("link", d3.forceLink(data.links).id(d=>d.id).distance(80))
  .force("charge", d3.forceManyBody().strength(-200))
  .force("center", d3.forceCenter(w/2, h/2))
  .force("collide", d3.forceCollide(20))
  .on("tick", () => {
    link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
    node.attr("cx",d=>d.x).attr("cy",d=>d.y);
    label.attr("x",d=>d.x).attr("y",d=>d.y);
  });

d3.select("#searchInput").on("input", function() {
  const q = this.value.toLowerCase();
  node.attr("opacity", d => d.label.toLowerCase().includes(q) || !q ? 1 : .1)
      .attr("r", d => d.label.toLowerCase().includes(q) && q ? Math.max(3, Math.min(18, d.degree*2.5)) : Math.max(3, Math.min(15, d.degree*2)));
  label.attr("opacity", d => d.label.toLowerCase().includes(q) || !q ? 1 : .1);
});

setTimeout(() => {
  const b = g.node().getBBox();
  const dx = b.width, dy = b.height, x = b.x+dx/2, y = b.y+dy/2;
  const scale = Math.min(.8, Math.min(w/(dx+80), h/(dy+80)));
  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(w/2-scale*x, h/2-scale*y).scale(scale));
}, 1500);
</script>
</body>
</html>`;
}
