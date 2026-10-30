import {readFile} from 'node:fs/promises';
import {allowed,LIMITS,repoName,textFile} from './evidence.mjs';
const fixture=JSON.parse(await readFile(new URL('../fixtures/milestoneproject.json',import.meta.url),'utf8'));
async function json(path){
 const r=await fetch('https://api.github.com/repos/'+path,{headers:{Accept:'application/vnd.github+json','User-Agent':'L2AI-Project-Assess'},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(`GitHub ${r.status}: public access unavailable, repository missing, or rate limit reached.`);
 const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>6000000)throw Error('GitHub response too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function resolveRepository(url,demo=false){
 const repository=repoName(url);let sha,tree,source;
 if(demo){if(repository!==fixture.repository)throw Error('Offline demo only supports the named milestoneproject snapshot');({sha,tree}=fixture);source='offline GitHub-plugin snapshot';}
 else{const meta=await json(repository);if(meta.private)throw Error('Only public repositories supported');const commit=await json(repository+'/commits/'+encodeURIComponent(meta.default_branch));sha=commit.sha;const result=await json(repository+'/git/trees/'+sha+'?recursive=1');if(result.truncated)throw Error('Repository tree is truncated; choose a smaller repository');tree=result.tree;source='live public GitHub API';}
 if(!/^[a-f0-9]{40}$/.test(sha)||tree.length>LIMITS.treeEntries)throw Error('Invalid SHA or repository too large');
 const files=tree.filter(f=>f.type==='blob'&&['100644','100755'].includes(f.mode)&&allowed(f.path,f.size)).map(f=>({path:f.path,size:f.size,blobSha:f.sha,available:!demo||fixture.files.some(x=>x.path===f.path)}));
 return {repository,sha,source,demo,files,treeEntries:tree.length,excludedEntries:tree.length-files.length,retrievedAt:new Date().toISOString()};
}
export async function readSelected(snapshot,paths){
 if(!Array.isArray(paths)||paths.length<1||paths.length>LIMITS.files||new Set(paths).size!==paths.length)throw Error('Select 1–5 unique text files');
 const files=[];let total=0;
 for(const path of paths){const entry=snapshot.files.find(f=>f.path===path);if(!entry||!entry.available)throw Error('File not available in this snapshot: '+path);
 let content;if(snapshot.demo)content=fixture.files.find(f=>f.path===path).content;else{const blob=await json(snapshot.repository+'/git/blobs/'+entry.blobSha);if(blob.encoding!=='base64'||blob.size>LIMITS.fileBytes)throw Error('Unsupported blob');content=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(blob.content,'base64'));}
 total+=Buffer.byteLength(content);if(total>LIMITS.totalBytes)throw Error('Selected text exceeds 90 KB');files.push(textFile(path,content,entry.blobSha));}return files;
}
