// >_  node index.js || npm run dev
const fs = require('fs');
const Path = require('path');
const https = require('https');
const { parseStringPromise } = require('xml2js');

// Files
const DUMP_DIR = Path.join(__dirname, '.dump.xx');
const CREDS_FILE = Path.join(__dirname, 'creds.json');
const SESSION_FILE = Path.join(DUMP_DIR, 'session.json');
const METADATA_FILE = Path.join(DUMP_DIR, 'metadata.json');
const COMPONENTS_FILE = Path.join(DUMP_DIR, 'components.json');

// Cache
const Cache = {
    creds: undefined,
    apiVersion: undefined,
    session: undefined,
};

// sleep milliseconds promise
function sleep(ms) {
    return new Promise((resolve) => void setTimeout(() => resolve(ms), ms));
}

// Path info
function pathInfo(path, mode = 0) {
	const _get_type = (info) => {
		if (info.isFile) return info.isSymbolicLink ? 4 : 1; 
		if (info.isDirectory) return info.isSymbolicLink ? 3 : 2; 
		return 0;
	}
	const _get_stats = (stats) => ({
		type: 0,
		path,
		path_full: Path.resolve(path),
		dir: Path.dirname(path),
		dir_full: Path.dirname(path, true),
		basename: Path.basename(path),
		target: fs.realpathSync(path),
		dev: stats.dev,
		mode: stats.mode,
		nlink: stats.nlink,
		uid: stats.uid,
		gid: stats.gid,
		rdev: stats.rdev,
		blksize: stats.blksize,
		ino: stats.ino,
		size: stats.size,
		blocks: stats.blocks,
		atimeMs: stats.atimeMs,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		birthtimeMs: stats.birthtimeMs,
		atime: stats.atime,
		mtime: stats.mtime,
		ctime: stats.ctime,
		birthtime: stats.birthtime,
		isDirectory: stats.isDirectory(),
		isFile: stats.isFile(),
		isBlockDevice: stats.isBlockDevice(),
		isCharacterDevice: stats.isCharacterDevice(),
		isSymbolicLink: stats.isSymbolicLink(),
		isFIFO: stats.isFIFO(),
		isSocket: stats.isSocket(),
	});
	let info = undefined;
	if (fs.existsSync(path)) {
		mode = [0, 1, 2].includes(mode = parseInt(mode) ?? 0) ? mode : 0
		if (mode === 0) info = _get_stats(fs.statSync(path));
		else if (mode === 1) info = _get_stats(fs.lstatSync(path));
		else {
			const stats = _get_stats(fs.statSync(path));
			const lstats = _get_stats(fs.lstatSync(path));
			for (const key in lstats){
				if (!lstats.hasOwnProperty(key)) continue;
				stats[key] = stats[key] || lstats[key];
			}
			info = stats;
		}
	}
	if (info) info.type = _get_type(info);
	return info;
};

// Validate directory path
function isDir(path, follow_symlink = true) {
	const info = pathInfo(path, follow_symlink ? 0 : 1);
	return !info ? false : info.isDirectory;
};

// Validate file path
function isFile(path, follow_symlink = true) {
	const info = pathInfo(path, follow_symlink ? 0 : 1);
	return !info ? false : !info.isDirectory;
}

// Create directory
function mkdir(path, mode = 0o777, recursive = true) {
    let info = pathInfo(path);
	if (info) {
		if (!info.isDirectory) throw new Error(`Create directory failed! The path already exists "${info.path_full}" (type = ${info.type}).`);
		return info.path_full;
	}
	try {
		fs.mkdirSync(path, {mode, recursive});
		if (!((info = pathInfo(path)) && info.isDirectory)) throw new TypeError(`Failed to resolve created directory real path (${path}).`);
		return info.path_full;
	}
	catch (e){
		throw new Error(`Create directory failed! ${e}`);
	}
}

// Read file
function readSync(path, parse = false, _default = undefined, _encoding = undefined) {
	try {
		if (!isFile(path)) throw new Error(`Read file does not exist (${path}).`);
		const buffer = fs.readFileSync(path, _encoding);
		if (!parse) return buffer;
		const content = buffer.toString();
		if (parse !== 'json') return content;
        let json, fail = `__fail_${Date.now()}__`;
        try {
            if (Object(json = JSON.parse(content)) !== json) json = fail;
        } catch (e) {
            json = fail;
        }
		if (json === fail) throw new Error(`Read file JSON parse content failed. (${path})`);
		return json;
	}
	catch (e) {
		if (_default === undefined) console.warn('[-] readSync failure: ', e);
		return _default;
	}
}

// Write file
function writeSync(path, content, append = false, abortController = undefined) {
	const opts = {};
	if (abortController instanceof AbortController) {
		const { signal } = abortController;
		opts.signal = signal;
	}
	if (append) opts.flag = 'a+';
    let dir = Path.dirname(path);
    if (dir !== '.' && !isDir(dir)) {
        dir = mkdir(dir);
        console.debug('[*] writeSync > mkdir:', {dir, path});
    }
	return fs.writeFileSync(path, content, opts);
}

// SOAP request helper
function soapRequest(url, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers
        }, res => {
            let data = ''
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Login and get session ID
async function login() {
    const { username, password, token, loginUrl } = Cache.creds;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Body>
                <n1:login xmlns:n1="urn:partner.soap.sforce.com">
                    <n1:username>${username}</n1:username>
                    <n1:password>${password}${token || ''}</n1:password>
                </n1:login>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'login',
        'Content-Length': Buffer.byteLength(body),
    };

    // session login
    console.debug('[*] Session Login...', [loginUrl, username]);
    const response = await soapRequest(loginUrl, headers, body);
    const result = await parseStringPromise(response);
    const res = result['soapenv:Envelope']['soapenv:Body'][0]['loginResponse'][0]['result'][0];
    
    // save session
    writeSync(SESSION_FILE, JSON.stringify(res, undefined, 4));
    console.log('[+] Session Saved:', SESSION_FILE.substring(__dirname.length + 1));
    
    // result
    return {
        sessionId: res.sessionId[0],
        metadataUrl: res.metadataServerUrl[0]
    };
}

// Describe Metadata
async function describeMetadata() {
    const { sessionId, metadataUrl } = Cache.session, apiVersion = Cache.apiVersion;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Header>
                <n1:SessionHeader xmlns:n1="http://soap.sforce.com/2006/04/metadata">
                    <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:describeMetadata xmlns:n2="http://soap.sforce.com/2006/04/metadata">
                    <n2:asOfVersion>${apiVersion}</n2:asOfVersion>
                </n2:describeMetadata>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'describeMetadata',
        'Content-Length': Buffer.byteLength(body),
    };
    
    // describe metadata
    console.debug('[*] Describe Metadata...', { sessionId, metadataUrl, apiVersion });
    const response = await soapRequest(metadataUrl, headers, body);
    const result = await parseStringPromise(response);
    const metadata = result['soapenv:Envelope']['soapenv:Body'][0]['describeMetadataResponse'][0]['result'][0];
    
    // metadata save output
    writeSync(METADATA_FILE, JSON.stringify(metadata, null, 4));
    console.log('[+] Metadata Saved:', METADATA_FILE.substring(__dirname.length + 1));
    
    // result
    return metadata;
}

// list metadata
async function listMetadata(typeName) {
    const { sessionId, metadataUrl } = Cache.session, apiVersion = Cache.apiVersion;
    const body = `
        <env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                      xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
            <env:Header>
                <n1:SessionHeader xmlns:n1="http://soap.sforce.com/2006/04/metadata">
                    <n1:sessionId>${sessionId}</n1:sessionId>
                </n1:SessionHeader>
            </env:Header>
            <env:Body>
                <n2:listMetadata xmlns:n2="http://soap.sforce.com/2006/04/metadata">
                    <n2:queries>
                        <n2:type>${typeName}</n2:type>
                    </n2:queries>
                    <n2:asOfVersion>${apiVersion}</n2:asOfVersion>
                </n2:listMetadata>
            </env:Body>
        </env:Envelope>
    `;
    const headers = {
        'Content-Type': 'text/xml',
        'SOAPAction': 'listMetadata',
        'Content-Length': Buffer.byteLength(body),
    };

    // list type metadata
    console.debug(`[*] List ${typeName} Metadata...`);
    const xml = await soapRequest(metadataUrl, headers, body);
    const res = await parseStringPromise(xml);
    const results = res?.['soapenv:Envelope']?.['soapenv:Body']?.[0]?.['listMetadataResponse']?.[0]?.['result'] || [];
    console.debug(`[*] List ${typeName} Metadata Results: ${results.length}`);
    
    // result
    return results;
}

// Main
(async () => {
    try {
        // login
        const creds = readSync(CREDS_FILE, 'json', undefined, 'utf8');
        if (Object(creds) !== creds) throw new Error('Failed to load creds!');
        Cache.creds = creds;
        Cache.apiVersion = creds.loginUrl.split('/').pop();
        Cache.session = await login();

        // describe metadata (all)
        const metadata = await describeMetadata();

        // components list metadata
        console.debug('[~] parse metadata objects...');
        const components = {};
        const cachedMetadata = {};
        const inFolderSet = new Set();
        const metaFileSet = new Set();
        const childTypeSet = new Set();
        const _add_components = async (type, key, isChild, isFolder) => {
            if (!components.hasOwnProperty(key)) components[key] = {};
            components[key][type] = {key, type, isChild, isFolder, count: 0, metadata: undefined};
            let res = undefined;
            const tag = key !== type ? `${key} => ${type}` : key;
            console.debug(`[*] Add ${tag} Components...`);
            if (!cachedMetadata.hasOwnProperty(type)) {
                await sleep(500); // delay
                res = await listMetadata(type).catch(err => {
                    console.error(`[!] list metadata (${tag}) failure:`, err);
                    return undefined;
                });
                if (Object(res) === res) cachedMetadata[type] = res;
            }
            else {
                res = cachedMetadata[type];
                console.debug(`[+] cached metadata (${tag}): `, JSON.stringify(res, undefined, 4));
            }
            const count = res?.length ?? 0;
            components[key][type].metadata = res;
            components[key][type].count = count;
        };
        for (const obj of (metadata.metadataObjects || [])) {
            const parent = obj.xmlName[0].trim();
            const isInFolder = obj.inFolder?.[0] === 'true';
            if (isInFolder) inFolderSet.add(parent);
            if (obj.metaFile?.[0] === 'true') metaFileSet.add(parent);
            
            // children list
            const objChildXmlNames = (obj.childXmlNames ?? []).map(v => 'string' === typeof v ? v.trim() : '').filter(v => v);
            if (objChildXmlNames.length) {
                for (let i = 0; i < objChildXmlNames.length; i ++) {
                    
                    // child type name
                    const name = objChildXmlNames[i] === 'ManagedTopic'
                    ? 'ManagedTopics' // ManagedTopic is not a valid component Type and it should be 'ManagedTopics'
                    : objChildXmlNames[i];
                    childTypeSet.add(name);
                    
                    // add components
                    await _add_components(name, parent, true, false);
                }
            }
            
            // parent type name
            let name = parent;
            if (isInFolder) {
                if (name === 'EmailTemplate') name = 'EmailFolder'; // EmailTemplate = EmailFolder (for some reason)
                else name = name + 'Folder';
            }

            // add components
            await _add_components(name, parent, false, isInFolder);
        }

        // components - save output
        writeSync(COMPONENTS_FILE, JSON.stringify(components, undefined, 4));
        console.log('[+] Components Saved:', COMPONENTS_FILE.substring(__dirname.length + 1));

        // extra info
        console.debug('[+] extra: ', JSON.stringify({
            inFolderSet: [...inFolderSet],
            metaFileSet: [...metaFileSet],
            childTypeSet: [...childTypeSet],
        }, undefined, 4));

        // done
        console.log('[+] done.');
    } catch (err) {

        // failure
        console.error('[!] Failed:', err.message || err);
        process.exit(1);
    }
})();
