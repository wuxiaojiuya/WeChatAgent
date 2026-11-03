import json, pathlib, shutil, socket, subprocess, sys, urllib.request
base=pathlib.Path(sys.argv[1]).resolve()
results=[]
for mode in ['ok','delay','cpp','seh','routes','bind','logfail']:
    case=base/'cases'/mode
    target=case/'state'/'hook'/'client'
    target.mkdir(parents=True,exist_ok=True)
    for name in ['InitProbe.exe','Weixin.dll']:shutil.copyfile(base/'bin'/name,target/name)
    if mode=='logfail':(case/'state'/'logs').write_text('fixture blocks logging directory',encoding='utf8')
    reservation=socket.socket()
    if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):reservation.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
    reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
    if mode=='bind':reservation.listen(1)
    else:reservation.close()
    process=subprocess.Popen([str(target/'InitProbe.exe'),mode,str(port),str(target/'Weixin.dll')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf8')
    try:
        first=process.stdout.readline().strip()
        expected='failed' if mode in ['cpp','seh','routes','bind'] else 'ready'
        assert first==expected+' 1',(mode,first)
        if expected=='ready':
            with urllib.request.urlopen('http://127.0.0.1:%d/fixture'%port,timeout=3) as response:assert response.read()==b'fixture'
        process.communicate('\n',timeout=10)
        assert process.returncode==0,(mode,process.returncode)
        log=case/'state'/'logs'/'hook-init.log'
        if mode!='logfail':
            text=log.read_text(encoding='utf8')
            assert 'stage=worker_enter' in text and 'stage=weixin_dll_ready' in text
            if mode=='cpp':assert 'exception=cpp stage=test_cpp' in text and 'fixture cpp failure' in text
            if mode=='seh':assert 'exception=seh stage=test_seh code=0xC0000005' in text
            if mode=='routes':assert 'exception=cpp stage=http_register_routes' in text
            if mode=='bind':assert 'stage=http_bind_failed' in text
        else:assert not log.exists()
        results.append({'case':mode,'state':expected,'singleInitialization':True,'passed':True})
    finally:
        if process.poll() is None:process.kill();process.communicate(timeout=5)
        reservation.close()
print(json.dumps({'tests':results,'wechatStarted':False,'messagesSent':0}))
