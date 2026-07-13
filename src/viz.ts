/**
 * Standalone HTML visualization of the knowledge graph.
 *
 * Uses vis.js (vis-network) for interactive graph visualization with:
 *   - ForceAtlas2 physics for natural clustering
 *   - Sidebar with node details on click
 *   - Community-based coloring
 *   - Search with dropdown
 *   - Legend with toggle per community
 *   - Node/edge caps for large graphs
 */

import type { KnowledgeGraph } from "./graph.ts";

const VIS_JS = "https://unpkg.com/vis-network@9.1.6/dist/vis-network.min.js";
const VIS_CSS = "https://unpkg.com/vis-network@9.1.6/dist/vis-network.min.css";
const MAX_VIZ_NODES = 1500;
const MAX_EDGES = 4000;

export function generateHtml(kg: KnowledgeGraph, title: string = "Mind Place"): string {
  // Sort non-file nodes by degree, take top
  const nonFileNodes = [...kg.nodes.values()]
    .filter(n => n.type !== "file")
    .map(n => ({ node: n, degree: kg.adjacency.get(n.id)?.size ?? 0 }))
    .sort((a, b) => b.degree - a.degree);

  const cappedNodes = nonFileNodes.slice(0, MAX_VIZ_NODES);
  const cappedIds = new Set(cappedNodes.map(n => n.node.id));

  // Colors from graphify's palette
  const COLORS = [
    "#4E79A7","#F28E2B","#E15759","#76B7B2","#59A14F",
    "#EDC948","#B07AA1","#FF9DA7","#9C755F","#BAB0AC",
    "#6A3D9A","#FF7F00","#33A02C","#1F78B4","#E31A1C",
    "#FDBF6F","#A6CEE3","#B2DF8A","#FB9A99","#CAB2D6",
    "#FFFF99","#B15928","#8DD3C7","#FFFFB3","#BEBADA",
  ];

  // Build nodes
  const nodes = cappedNodes.map(n => {
    const node = n.node;
    const comm = node.community ?? 0;
    return {
      id: node.id, label: node.label, color: COLORS[comm % COLORS.length],
      size: Math.max(5, Math.min(25, Math.log2(n.degree + 2) * 8)),
      font: { size: 10, color: "#ddd" },
      title: `<b>${node.label}</b> (${node.type})<br>${node.sourceFile}${node.sourceLocation ? " " + node.sourceLocation : ""}<br>${n.degree} connections`,
      community: comm,
      sourceFile: node.sourceFile, fileType: node.type, degree: n.degree,
    };
  });

  // Build edges (only between capped nodes)
  const edges = [];
  for (const edge of kg.edges) {
    if (edges.length >= MAX_EDGES) break;
    if (!cappedIds.has(edge.source) || !cappedIds.has(edge.target)) continue;
    edges.push({
      from: edge.source, to: edge.target,
      title: `${edge.relation} [${edge.confidence}]`,
      dashes: edge.confidence !== "EXTRACTED",
      width: edge.confidence === "EXTRACTED" ? 1 : 0.5,
      color: { color: edge.confidence === "EXTRACTED" ? "#555" : "#444", opacity: edge.confidence === "EXTRACTED" ? 0.4 : 0.25 },
    });
  }

  // Legend
  const legend = new Map<number, { label: string; color: string; count: number }>();
  for (const n of cappedNodes) {
    const comm = n.node.community ?? 0;
    const c = legend.get(comm) ?? { label: `Community ${comm}`, color: COLORS[comm % COLORS.length], count: 0 };
    c.count++;
    if (c.label === `Community ${comm}`) c.label = n.node.label;
    legend.set(comm, c);
  }
  const legendArr = [...legend.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 50);

  const totalNodes = kg.nodes.size;
  const shownInfo = cappedNodes.length < nonFileNodes.length
    ? `Showing ${cappedNodes.length} of ${nonFileNodes.length} nodes (top by connections)`
    : `${cappedNodes.length} nodes`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - Mind Place</title>
<link rel="stylesheet" href="${VIS_CSS}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f1a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;height:100vh;overflow:hidden}
#graph{flex:1}
#sidebar{width:280px;background:#1a1a2e;border-left:1px solid #2a2a4e;display:flex;flex-direction:column;overflow:hidden}
#search-wrap{padding:12px;border-bottom:1px solid #2a2a4e}
#search{width:100%;background:#0f0f1a;border:1px solid #3a3a5e;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:13px;outline:none}
#search:focus{border-color:#4E79A7}
#search-results{max-height:140px;overflow-y:auto;padding:4px 12px;border-bottom:1px solid #2a2a4e;display:none}
.search-item{padding:4px 6px;cursor:pointer;border-radius:4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.search-item:hover{background:#2a2a4e}
#info-panel{padding:14px;border-bottom:1px solid #2a2a4e;min-height:100px}
#info-panel h3{font-size:13px;color:#aaa;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
#info-content{font-size:13px;color:#ccc;line-height:1.6}
#info-content .field{margin-bottom:5px}
#info-content .field b{color:#e0e0e0}
#info-content .empty{color:#555;font-style:italic}
.neighbor-link{display:block;padding:2px 6px;margin:2px 0;border-radius:3px;cursor:pointer;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:3px solid #333}
.neighbor-link:hover{background:#2a2a4e}
#neighbors-list{max-height:160px;overflow-y:auto;margin-top:4px}
#legend-wrap{flex:1;overflow-y:auto;padding:12px}
#legend-wrap h3{font-size:13px;color:#aaa;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em}
.legend-item{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;border-radius:4px;font-size:12px}
.legend-item:hover{background:#2a2a4e}
.legend-item.dimmed{opacity:.35}
.legend-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.legend-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.legend-count{color:#666;font-size:11px}
#legend-controls{margin-bottom:8px}
#legend-controls label{cursor:pointer;font-size:12px;color:#aaa;user-select:none}
#legend-controls label:hover{color:#e0e0e0}
#stats{padding:10px 14px;border-top:1px solid #2a2a4e;font-size:11px;color:#555}
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="search-wrap"><input type="text" id="search" placeholder="Search nodes..."></div>
  <div id="search-results"></div>
  <div id="info-panel">
    <h3>Node Details</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <div id="legend-controls"><label><input type="checkbox" id="select-all-cb" checked onclick="toggleAll(this.checked)"> Show all</label></div>
    <h3>Communities</h3>
    <div id="legend-list"></div>
  </div>
  <div id="stats">${shownInfo} · ${edges.length} edges · ${totalNodes} total</div>
</div>
<script src="${VIS_JS}"></script>
<script>
const RAW_NODES = ${JSON.stringify(nodes)};
const RAW_EDGES = ${JSON.stringify(edges)};
const LEGEND = ${JSON.stringify(legendArr)};
const COLORS = ${JSON.stringify(COLORS)};

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

const nodesDS = new vis.DataSet(RAW_NODES.map(n=>({
  id:n.id,label:n.label,color:n.color,size:n.size,font:n.font,title:n.title,
  _c:n.community,_f:n.sourceFile,_t:n.fileType,_d:n.degree
})));
const edgesDS = new vis.DataSet(RAW_EDGES.map((e,i)=>({
  id:i,from:e.from,to:e.to,title:e.title,dashes:e.dashes,width:e.width,color:e.color,
  arrows:{to:{enabled:true,scaleFactor:.5}}
})));

const network = new vis.Network(document.getElementById('graph'),{nodes:nodesDS,edges:edgesDS},{
  physics:{enabled:true,solver:'forceAtlas2Based',
    forceAtlas2Based:{gravitationalConstant:-60,centralGravity:.005,springLength:120,springConstant:.08,damping:.4,avoidOverlap:.8},
    stabilization:{iterations:200,fit:true}},
  interaction:{hover:true,tooltipDelay:100,hideEdgesOnDrag:true,navigationButtons:false,keyboard:false},
  nodes:{shape:'dot',borderWidth:1.5},
  edges:{smooth:{type:'continuous',roundness:.2},selectionWidth:3}
});

network.once('stabilizationIterationsDone',()=>{network.setOptions({physics:{enabled:false}});});

function showInfo(id){
  const n=nodesDS.get(id);if(!n)return;
  const nids=network.getConnectedNodes(id);
  const items=nids.slice(0,30).map(nid=>{
    const nb=nodesDS.get(nid);
    return '<span class="neighbor-link" style="border-left-color:'+esc(nb?String(nb.color):'#555')+'" onclick="focusNode(&quot;'+esc(nid)+'&quot;)">'+esc(nb?nb.label:nid)+'</span>';
  }).join('');
  document.getElementById('info-content').innerHTML=
    '<div class="field"><b>'+esc(n.label)+'</b></div>'+
    '<div class="field">Type: '+esc(n._t||'?')+'</div>'+
    '<div class="field">File: '+esc((n._f||'').slice(-50))+'</div>'+
    '<div class="field">Connections: '+n._d+'</div>'+
    (nids.length?'<div class="field" style="margin-top:8px;color:#aaa;font-size:11px">Neighbors ('+nids.length+')</div><div id="neighbors-list">'+items+'</div>':'');
}
function focusNode(id){network.focus(id,{scale:1.4,animation:true});network.selectNodes([id]);showInfo(id);}

let hovered=null;
network.on('hoverNode',p=>{hovered=p.node;});
network.on('blurNode',()=>{hovered=null;});
network.on('click',p=>{if(p.nodes.length>0)showInfo(p.nodes[0]);else if(!hovered)document.getElementById('info-content').innerHTML='<span class="empty">Click a node to inspect it</span>';});

const si=document.getElementById('search'),sr=document.getElementById('search-results');
si.addEventListener('input',()=>{
  const q=si.value.toLowerCase();
  if(!q){sr.style.display='none';return;}
  const m=RAW_NODES.filter(n=>n.label.toLowerCase().includes(q)).slice(0,15);
  sr.style.display=m.length?'block':'none';
  sr.innerHTML=m.map(n=>'<div class="search-item" onclick="focusNode(&quot;'+esc(n.id)+'&quot;)">'+esc(n.label)+' ('+esc(n.fileType)+')</div>').join('');
});

const ll=document.getElementById('legend-list');
const hidden=new Set();
LEGEND.forEach((l,i)=>{
  const d=document.createElement('div');d.className='legend-item';
  d.innerHTML='<div class="legend-dot" style="background:'+l[1].color+'"></div><span class="legend-label">'+esc(l[1].label)+'</span><span class="legend-count">'+l[1].count+'</span>';
  d.onclick=()=>{d.classList.toggle('dimmed');const show=!d.classList.contains('dimmed');if(!show)hidden.add(l[0]);else hidden.delete(l[0]);
    nodesDS.forEach(n=>{if(n._c>=0&&hidden.has(n._c)){nodesDS.update({id:n.id,hidden:true});}else{nodesDS.update({id:n.id,hidden:false});}});};
  ll.appendChild(d);
});
function toggleAll(show){hidden.clear();nodesDS.forEach(n=>{nodesDS.update({id:n.id,hidden:!show});});
  document.querySelectorAll('.legend-item').forEach(el=>el.classList.toggle('dimmed',!show));
  document.getElementById('select-all-cb').indeterminate=false;}
</script>
</body>
</html>`;
}
