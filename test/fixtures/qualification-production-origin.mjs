// Hermetic production-path stand-in: local HTTPS, synthetic visitor/voice API,
// real browser microphone/output. No provider, agent or external network calls.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function startFakeProductionOrigin(directory, { mediaElement = false, assistantFinal = 'before-audio', opener = 'normal', userFinalDelayMs = 400 } = {}) {
  const key = join(directory, 'synthetic-tls-key.pem'), cert = join(directory, 'synthetic-tls-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=start2.fixture.test'], { stdio: 'ignore' });
  const username = 'fixture-operator', password = 'SYNTHETIC_BASIC_AUTH_SENTINEL', requests = [], dispatches = [];
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  let origin, otherOrigin, stopped = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    // Retain headers only for the deliberately separate origin, whose credential
    // absence is the assertion. Never retain the successful auth-bearing request.
    if (url.hostname === 'other.fixture.test') {
      requests.push({ origin: url.origin, authorization: req.headers.authorization });
      if (url.pathname === '/challenge' && !req.headers.authorization) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="other-origin"', 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }); res.end(); return;
      }
      res.writeHead(200, { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }); res.end('other'); return;
    }
    if (req.headers.authorization !== expectedAuth) { res.writeHead(401, { 'www-authenticate': 'Basic realm="fake-start2"' }); res.end(); return; }
    let text = ''; for await (const bytes of req) text += bytes;
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/sessions') { res.setHeader('set-cookie', 'aithema-visitor=production-browser-owner; Secure; HttpOnly; SameSite=Strict; Path=/'); json({ id: 'production-visitor' }); return; }
    if (url.pathname.startsWith('/api/') && req.headers.cookie !== 'aithema-visitor=production-browser-owner') { res.writeHead(403); res.end(); return; }
    if (url.pathname.endsWith('/voice')) { dispatches.push('production-conversation'); json({ callId: 'fake-call', providerSessionId: 'conv_production', epoch: 0, controllingTabId: 'fake-tab' }); return; }
    if (url.pathname.endsWith('/close')) { stopped++; json({ closureConfirmed: false }); return; }
    if (url.pathname.startsWith('/api/')) { json({ granted: true }); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/consent/') {
      res.end(`<!doctype html><div id="consent-status" data-state="ready"></div>
        <input name="item" type="checkbox" value="voice-elevenlabs"><input name="item" type="checkbox" value="models-international">
        <button data-grant>Grant presented consent</button><script>
        document.querySelector('[data-grant]').onclick=async()=>{await fetch('/api/sessions/production-visitor/consent',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({granted:true,processing:{contract:'fake-production-contract',items:['voice-elevenlabs','models-international']}})});
          sessionStorage.setItem('consented','1');location.href='/';};</script>`); return;
    }
    // Legacy direct-probe negative controls retain their fixed WAV. Scripted
    // capture cases use a short reply timer after their opener; no fixture time
    // is forwarded as evidence.
    // Corpus timing source: composed-qualification.test.js's WAV has utterance
    // 20..20.5 s and barge-in from 21.8 s after a fixed 20 s prefix. These fixture timers mimic provider final
    // callbacks/reply audio; they never enter probe timestamps or expected text.
    res.end(`<!doctype html><aithema-session></aithema-session><script>
      (async()=>{
      if(!sessionStorage.getItem('visitor')){await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});sessionStorage.setItem('visitor','1');}
      fetch(${JSON.stringify(otherOrigin + '/plain')},{mode:'cors',credentials:'include'}).catch(()=>{});
      fetch(${JSON.stringify(otherOrigin + '/challenge')},{mode:'cors',credentials:'include'}).catch(()=>{});
      const root=document.querySelector('aithema-session').attachShadow({mode:'open'});
      if(!sessionStorage.getItem('consented')){root.innerHTML='<button class="chooser__continue">Continue</button>';root.querySelector('button').onclick=()=>location.href='/consent/';return;}
      root.innerHTML='<button class="ready__mode" data-mode="voice">Voice</button><button class="ready__start">Start</button><button class="voice-close">Stop</button><div class="audio-rail" data-state="listening"></div>';
      let context,oscillator,gain,stream;
      root.querySelector('.voice-close').onclick=()=>{if(gain){gain.gain.cancelScheduledValues(context.currentTime);gain.gain.setValueAtTime(0,context.currentTime);}stream?.getTracks().forEach(t=>t.stop());};
      root.querySelector('.ready__start').onclick=async()=>{
        await fetch('/api/sessions/production-visitor/voice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({callId:'fake-call',tabId:'fake-tab'})});
        stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
        context=new AudioContext();await context.resume();
        const input=context.createMediaStreamSource(stream),detect=context.createScriptProcessor(1024,1,1),silent=context.createGain();silent.gain.value=0;
        input.connect(detect);detect.connect(silent).connect(context.destination);
        let answering=false;
        detect.onaudioprocess=e=>{const samples=e.inputBuffer.getChannelData(0);if(answering&&Math.sqrt(samples.reduce((s,x)=>s+x*x,0)/samples.length)>=.015){gain.gain.cancelScheduledValues(context.currentTime);gain.gain.setValueAtTime(0,context.currentTime);
          answering=false;fetch('/api/sessions/production-visitor/voice/fake-call/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:{type:'final',role:'user',userTurnOrdinal:2,text:'Bitte aufhören'}})});}};
        const replyDelay=window.qualificationScriptedCapture ? 2000 : 21000;
        setTimeout(()=>{window.fixtureUserFinalAt=performance.now();fetch('/api/sessions/production-visitor/voice/fake-call/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:{type:'final',role:'user',userTurnOrdinal:1,text:'Wien'}})});},replyDelay+${JSON.stringify(userFinalDelayMs)});
        const final=()=>{window.fixtureAssistantFinalAt=performance.now();return fetch('/api/sessions/production-visitor/voice/fake-call/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:{type:'final',role:'assistant',text:'Danke.'}})});};
        oscillator=context.createOscillator();gain=context.createGain();gain.gain.value=0;
        ${mediaElement ? `const destination=context.createMediaStreamDestination();oscillator.connect(gain).connect(destination);
        const audio=new Audio();audio.srcObject=destination.stream;document.body.append(audio);await audio.play();` : 'oscillator.connect(gain).connect(context.destination);'}
        // An audible opener on the SAME graph must never enter the reply PCM.
        const start=context.currentTime;oscillator.start();
        const rail=root.querySelector('.audio-rail');rail.dataset.state='speaking';
        const openerStart=${JSON.stringify(opener)}==='delayed' ? .7 : .05;
        gain.gain.setValueAtTime(.6,start+openerStart);gain.gain.setValueAtTime(0,start+openerStart+.2);
        // A multi-sentence opener with a real gap, followed by its OWN final
        // and SDK playback-completion state; never hide it inside user speech.
        gain.gain.setValueAtTime(.6,start+openerStart+.35);gain.gain.setValueAtTime(0,start+openerStart+.55);
        setTimeout(()=>fetch('/api/sessions/production-visitor/voice/fake-call/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:{type:'final',role:'assistant',turnId:'opener',text:'AI notice. How can I help?'}})}),(openerStart+.6)*1000);
        setTimeout(()=>{rail.dataset.state='listening';},(openerStart+.65)*1000);
        gain.gain.setValueAtTime(.2,start+(replyDelay+50)/1000);gain.gain.setValueAtTime(.08,start+(replyDelay+300)/1000);
        window.fixtureReplyContextTime=start+(replyDelay+50)/1000;
        window.fixtureOutputClock=()=>context.getOutputTimestamp();
        if(${JSON.stringify(assistantFinal)}==='before-audio')setTimeout(final,replyDelay);
        if(${JSON.stringify(assistantFinal)}==='after-audio')setTimeout(final,replyDelay+500);
        setTimeout(()=>{answering=true;},replyDelay+100);
      };})();</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `https://start2.fixture.test:${server.address().port}`;
  otherOrigin = `https://other.fixture.test:${server.address().port}`;
  return { origin, otherOrigin, username, password, requests, dispatches, get stopped() { return stopped; },
    launchArgs: ['--ignore-certificate-errors', '--no-proxy-server', '--host-resolver-rules=MAP *.fixture.test 127.0.0.1'],
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
