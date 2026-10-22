import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";
import { effectiveSocial, readSocial } from "../src/lib/publications/social";
import { readablePublicationSql } from "../src/lib/publications/index-db";

const alice = {id:"alice"}, bob = {id:"bob"};
async function setup(t: {after(fn:()=>Promise<void>):unknown}) {
 const root=await mkdtemp(join(tmpdir(),"xi-feed-"));
 const vault=await openVault(root); const db=new Database(":memory:");
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const store=createPublicationStore({vault,db});
 async function publish(visibility:"public"|"followers"|"private", replyTo?:string) {
  const id=await store.create(alice,replyTo);const draft=await store.getEditable(alice,id);
  const saved=await store.save(alice,id,{baseRevision:draft.revision,summary:"",visibility,messages:[{key:"a",file:null,body:"Message public"}]});
  assert.ok(saved.ok);await store.publish(alice,id,saved.snapshot.revision);return id;
 }
 return {root,vault,db,store,publish};
}

test("subscriptions grant followers access, explicit hiding preserves chronology, revocation updates graph SQL",async t=>{
 const {store,publish,db}=await setup(t); const id=await publish("followers"); const privateId=await publish("private");
 await assert.rejects(store.get(bob,id));
 await store.setSocial(bob,alice.id,{following:true,preference:"less"});
 assert.equal((await store.get(bob,id)).id,id);
 assert.deepEqual((await store.page(bob,{kind:"home",tab:"following"})).items.map(p=>p.id),[id]);
 await assert.rejects(store.get(bob,privateId));
 const query=db.prepare(`SELECT p.id FROM publication p WHERE ${readablePublicationSql("p")}`);
 assert.deepEqual(query.all({viewer:bob.id}),[{id}]);
 await store.setSocial(bob,alice.id,{preference:"hidden"});
 assert.equal((await store.page(bob,{kind:"home",tab:"following"})).items.length,0);
 await store.setSocial(bob,alice.id,{following:false}); await store.reconcileAll();
 assert.deepEqual(query.all({viewer:bob.id}),[]); await assert.rejects(store.get(bob,id));
});

test("hierarchy inherits follows and editorial preference independently with explicit override",()=>{
 const accounts=[{id:"p",parentId:null,handle:"science"},{id:"c",parentId:"p",handle:"science.space"}] as Parameters<typeof effectiveSocial>[1];
 const result=effectiveSocial({following:["p"],preferences:{p:"hidden",c:"priority"}},accounts);
 assert.ok(result.following.has("c")); assert.equal(result.preferences.c,"priority");
});

test("reply parents are permission filtered and published analyses require a new version",async t=>{
 const {root,store,publish}=await setup(t);const parent=await publish("public");const reply=await publish("public",`${parent}/1`);
 assert.equal((await store.get(bob,reply)).parentContext?.publicationId,parent);
 const folders=await readdir(join(root,"posts","_users",alice.id));
 for(const folder of folders){const path=join(root,"posts","_users",alice.id,folder,"index.md");const text=await readFile(path,"utf8");if(text.includes(`id: ${parent}`)) await writeFile(path,text.replace("visibility: public","visibility: private"));}
 assert.equal((await store.get(bob,reply)).parentContext,undefined);
 await assert.rejects(store.create(bob,`${parent}/1`));
 // Set analysis marker on the actual parent note.
 for(const name of folders){const path=join(root,"posts","_users",alice.id,name,"index.md");const text=await readFile(path,"utf8");if(text.includes(`id: ${parent}`))await writeFile(path,text.replace("---\n","---\nanalysis: true\n"));}
 const analysis=await store.getEditable(alice,parent);
 await assert.rejects(store.save(alice,parent,{baseRevision:analysis.revision,summary:"changed",visibility:"private",messages:[]}));
 const correction=await store.createCorrection(alice,parent); assert.notEqual(correction,parent); assert.equal((await store.getEditable(alice,correction)).status,"draft");
});

test("social settings refuse symlinks escaping the user's folder",async t=>{
 const {root,vault}=await setup(t);const dir=join(root,"posts","_users",bob.id);await mkdir(dir,{recursive:true});
 await writeFile(join(root,"secret.md"),"---\nfollowing: [alice]\n---\n");await symlink(join(root,"secret.md"),join(dir,"feed.md"));
 await assert.rejects(readSocial(vault,bob));
});

test("for-you alternates authors within each explicit preference tier and paginates without loss", async t => {
 const {store}=await setup(t);
 const authors=[alice,bob,{id:"charlie"}];
 for (const author of authors) for(let n=0;n<5;n++) {
  const id=await store.create(author); const draft=await store.getEditable(author,id);
  const saved=await store.save(author,id,{baseRevision:draft.revision,summary:`${author.id} ${n}`,visibility:"public",messages:[]});
  assert.ok(saved.ok); await store.publish(author,id,saved.snapshot.revision);
 }
 const viewer={id:"reader"};
 const first=await store.page(viewer,{kind:"home",tab:"for-you"},null,3);
 assert.equal(new Set(first.items.map(p=>p.authorId)).size,3);
 const ids=first.items.map(p=>p.id); let cursor=first.nextCursor;
 while(cursor){const page=await store.page(viewer,{kind:"home",tab:"for-you"},cursor,3);ids.push(...page.items.map(p=>p.id));cursor=page.nextCursor;}
 assert.equal(ids.length,15);assert.equal(new Set(ids).size,15);
 await store.setSocial(viewer,alice.id,{preference:"priority"});
 const priority=await store.page(viewer,{kind:"home",tab:"for-you"},null,5);
 assert.ok(priority.items.every(p=>p.authorId===alice.id));
 await store.setSocial(viewer,bob.id,{preference:"hidden"});
 assert.ok((await store.page(viewer,{kind:"home"})).items.every(p=>p.authorId!==bob.id));
});

test("feed cursors reject changed ordering rather than skipping entries after a burst", async t => {
 const {store,publish}=await setup(t);
 await publish("public");await publish("public");
 const first=await store.page(bob,{kind:"home"},null,1);
 await publish("public");
 await assert.rejects(store.page(bob,{kind:"home"},first.nextCursor,1), {code:"stale_cursor"});
 const all=await store.page(bob,{kind:"home"});assert.equal(all.items.length,3);
});

test("live window bridges multi-page bursts, removes absent members and restarts stale cursors", async () => {
 const {loadFeedWindow,FeedChanged}=await import("../src/components/publications/feed-window");
 type Page=import("../src/components/publications/feed-window").FeedPage;
 const item=(id:string)=>({id} as Page["items"][number]);
 const ids=Array.from({length:85},(_,i)=>String(i));
 let stale=true;let starts=0;
 const result=await loadFeedWindow(async cursor=>{
  if(!cursor)starts++;
  if(cursor && stale){stale=false;throw new FeedChanged();}
  const start=Number(cursor??0);
  return {items:ids.slice(start,start+20).map(item),authors:{},nextCursor:start+20<ids.length?String(start+20):null};
 },["60","61","62","63","64"]);
 assert.equal(starts,2);
 assert.deepEqual(result.items.map(p=>p.id),ids.slice(0,80));
 assert.equal(result.nextCursor,"80");
 const removed=await loadFeedWindow(async()=>({items:[item("remaining")],authors:{},nextCursor:null}),["unfollowed"]);
 assert.deepEqual(removed.items.map(p=>p.id),["remaining"]);
 await assert.rejects(loadFeedWindow(async()=>{throw new FeedChanged();},[]),FeedChanged);
});

test("hiding an author affects feed membership, never detail access or its live updates", async t => {
 const {store,publish}=await setup(t);
 const id=await publish("public");
 await store.setSocial(bob,alice.id,{preference:"hidden"});
 assert.equal((await store.page(bob,{kind:"home"})).items.length,0);
 assert.equal((await store.get(bob,id)).id,id);
 assert.ok((await store.realtimeState(bob)).publications.some(publication=>publication.id===id));
});
