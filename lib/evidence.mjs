import {createHash} from 'node:crypto';
export const LIMITS={files:5,fileBytes:30000,totalBytes:90000,treeEntries:10000,textChars:6000};
export function repoName(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname))throw Error('Use a public https://github.com/owner/repository URL.');
 return u.pathname.replace(/^\//,'').replace(/\/$/,'').replace(/\.git$/,'');
}
export function allowed(path,size=0){
 if(typeof path!=='string'||path.length>300||path.split('/').some(p=>p==='..'||p.startsWith('.'))||size>LIMITS.fileBytes)return false;
 if(/(^|\/)(node_modules|vendor|dist|build|coverage|target|secrets?|credentials?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)(\/|$)/i.test(path))return false;
 if(/(^|\/)(.*(?:secret|credential|private.?key).*|id_rsa|id_ed25519|.*\.min\.js)$/i.test(path))return false;
 return /\.(md|txt|ts|tsx|js|jsx|mjs|json|java|py|sql|css|html|yml|yaml|xml|csv|c|cpp|h|go|rs)$/i.test(path);
}
export function textFile(path,content,blobSha){
 if(!allowed(path,Buffer.byteLength(content))||content.includes('\0')||content.includes('\uFFFD'))throw Error('Unsupported or oversized text: '+path);
 if(/-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(content))throw Error('Possible credential detected; excluded: '+path);
 return {path,content,blobSha,sha256:createHash('sha256').update(content).digest('hex'),lines:content.split('\n').length};
}
export function citation(c,files){
 const f=files.find(f=>f.path===c?.path);
 if(!f||!Number.isInteger(c.startLine)||!Number.isInteger(c.endLine)||c.startLine<1||c.endLine<c.startLine||c.endLine>f.lines||c.endLine-c.startLine>20)throw Error('Invalid evidence reference');
 const quote=f.content.split('\n').slice(c.startLine-1,c.endLine).join('\n');
 if(c.quote!==quote||!quote.trim())throw Error('Evidence quote does not match the pinned file');
 return c;
}
export function validateAnalysis(a,files){
 const keys=(obj,names)=>{if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!names.includes(k)))throw Error('Unexpected model fields');};
 keys(a,['summary','observations','questions','limitations']);
 const str=(v,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Invalid model text');};
 str(a.summary);if(!Array.isArray(a.observations)||a.observations.length<1||a.observations.length>10)throw Error('Invalid observations');
 for(const o of a.observations){keys(o,['kind','text','evidence']);str(o.text);if(!['document-description','code-observation','test-description','inference'].includes(o.kind))throw Error('Invalid observation kind');citation(o.evidence,files);}
 if(!Array.isArray(a.questions)||a.questions.length<3||a.questions.length>5)throw Error('Expected 3–5 questions');
 for(const q of a.questions){keys(q,['text','why','intent','evidence']);str(q.text);str(q.why);str(q.intent);if(!Array.isArray(q.evidence)||!q.evidence.length||q.evidence.length>5)throw Error('Missing question evidence');q.evidence.forEach(c=>citation(c,files));}
 if(!Array.isArray(a.limitations)||a.limitations.length>20)throw Error('Invalid limitations');a.limitations.forEach(v=>str(v));return a;
}
export function mockAnalysis(files,focus,history){
 const refs=files.map(f=>{const lines=f.content.split('\n');let i=lines.findIndex(s=>/^(export (?:async )?function |test\(|# )/.test(s));if(i<0)i=lines.findIndex(s=>s.trim());return {path:f.path,startLine:i+1,endLine:i+1,quote:lines[i]};});
 const prompts=[['Explain the design decision in this material and one alternative you considered.','Explore design reasoning','Understand trade-offs'],['Show one change relevant to the assessment focus and explain its effect.','Connect the selected material to the teacher focus','Understand implementation reasoning'],['What check would demonstrate this behaviour, and what remains untested?','Separate test descriptions from observed results','Identify verification gaps'],[history?'Compare your earlier progress record with this material. What changed and what evidence is missing?':'Which part needs additional evidence before we can assess it confidently?','Plan follow-up evidence','Understand uncertainty']];
 return {summary:'MOCK rehearsal: selected '+files.length+' files. This deterministic template quotes source text; it does not understand or evaluate the project. Teacher focus: '+focus,
 observations:refs.map(evidence=>({kind:/\.(md|txt)$/.test(evidence.path)?'document-description':/test/i.test(evidence.path)?'test-description':'code-observation',text:'The selected file contains the quoted text. No runtime behaviour or successful test execution is established.',evidence})),
 questions:prompts.map(([text,why,intent],i)=>({text:`${refs[i%refs.length].path} (line ${refs[i%refs.length].startLine}): ${text}`,why:why+'; consider: '+focus,intent,evidence:[refs[i%refs.length]]})),
 limitations:['MOCK: generic interview prompts, not model reasoning.','Only selected files were read; other files and runtime behaviour are unknown.','Documentation and test definitions may be outdated; no repository code was executed.','File presence, commit metadata and explanations do not establish authorship or individual contribution.',history?'Pasted history is unverified context; no automatic cross-session comparison was performed.':'No previous session record was supplied.']};
}
