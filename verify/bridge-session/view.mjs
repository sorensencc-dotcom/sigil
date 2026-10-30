const L={idle:"waiting",running:"agent thinking",replied:"reply visible",stored:"session saved"};
export const title="Resume bridge: two mentions in a row (one room)";
export const state=(v)=>({"Turn A (thread A)":L[v.pc.A],"Turn B (thread B)":L[v.pc.B]+(v.pc.B!=="idle"&&v.readSess.B!=="s1"?", started without session":"")});
export const step=(a,f,t)=>{for(const k of["A","B"]){if(f.pc[k]!==t.pc[k]){if(t.pc[k]==="running")return k==="B"&&f.pc.A==="replied"?"next mention starts [before A's session is saved]":"mention arrives";if(t.pc[k]==="replied")return "agent replies, reply posted";if(t.pc[k]==="stored")return "session + thread cursor saved";}}return null;};
