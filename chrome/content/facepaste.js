(function(global) {
	

// Quick&Dirty URL object by Plater
function buildURIObject(str)
{
	var retval={Org:str,clipped:"",query:"",pathparts:[""],params:{}};
	retval.clipped=retval.Org;
	
	var splitspot=str.indexOf("?");
	if(splitspot!=-1)	
	{	
		retval.clipped=str.substring(0,splitspot);//Left side
		retval.query=str.substring(splitspot);//right side
		retval.params=splitQuery(retval.query);
	}
	retval.pathparts=(retval.clipped||"").split('/');//Left side	
	
	return retval;
}

function splitQuery(strQ)
{
	var retval={};
	var args = (strQ||"").split('&');
	for (var i = 0; i < args.length; i++) 
	{
		var nvPair=args[i].split('=');
		retval[nvPair[0]] = decodeURIComponent((nvPair[1]||"")); //doesn't handle multiple names correctly, will clobber => a=fred&a=bill
	}
	return retval;
}
/////////////////////////////////////////////////////////////////////////////////////////

var Cc = Components.classes;
var Ci = Components.interfaces;
var Cr = Components.results;
var Cu = Components.utils;
var O = window.arguments[0];
var C = O.content;
var D = C.document;
var A = [], P = [];
var Ad = 0, Pd = 0, Pa = 0;
var userOptions=
{
	maxPhotosAtATime:3,//used to be a hardcoded 8
	showPhotosInDownloadHistory:false,
	maxTimeToSearchForImageMS:60*1000
	//,whichFilenameTypeSelected:1 //(selectedIndex)
}; // I want these options to be user settable

var useSavedPrefs=0;
console.log("useSavedPrefs="+useSavedPrefs);
if(useSavedPrefs==1)
{
	//Consider getting all prefs with getChildList() and using getPrefType() to build up the object?
	var prefs = Cc["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefService);
	prefs=prefs.getBranch("extensions.facepaste.");
	userOptions.showPhotosInDownloadHistory = prefs.getBoolPref("showPhotosInDownloadHistory");
	userOptions.maxPhotosAtATime = prefs.getIntPref("maxPhotosAtATime");
}

//sanitize user options
if (userOptions.maxPhotosAtATime<1){userOptions.maxPhotosAtATime=1;}

const {Downloads} = Cu.import("resource://gre/modules/Downloads.jsm", {});//go ahead and try it out?
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var browser;
var outdir = Cc["@mozilla.org/file/directory_service;1"].getService(Components.interfaces.nsIProperties).get("DfltDwnld", Components.interfaces.nsIFile);
var progress_lines = [];
var progress_lines_used = [50, 25];
var progress_lines_max = [50, 25];
var album_list_available = false;

/* utils */

function _(iterable) {	return Array.prototype.slice.call(iterable);}
function $q(doc, elsel) {	return (typeof elsel === 'string') ?		_(doc.querySelectorAll(elsel)) : [elsel];}
function $(elsel) {	return $q(document, elsel);}
function $c(elsel) {	return $q(D, elsel);}
function $b(elsel) {	return $q(browser.contentDocument, elsel);}
function $$(elsel) {	return $(elsel)[0];}
function $$c(elsel) {	return $c(elsel)[0];}
function $$b(elsel) {	return $b(elsel)[0];}
function E(selector, event, func) {		$(selector).forEach(function(e) {		e.addEventListener(event, func, false);	}); }
function Ec(selector, event, func) {	$c(selector).forEach(function(e) {		e.addEventListener(event, func, false);	}); }
function ER(selector, event, func) {	$(selector).forEach(function(e) {		e.removeEventListener(event, func, false);	}); }

function sanitise_fn(name) 
{
	// windows is the most restrictive with file names, to make the logic
	// a little simpler we'll use windows' rules for everyone as per:
	// msdn.microsoft.com/en-us/library/windows/desktop/aa365247(v=vs.85)
	return name.
		// no C0 control codes or characters in <>:"/\|?*
		replace(/[<>:"\/\\|?*\u0000-\u001f]/g, '_').
		// no file names that are entirely reserved DOS device names
		replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/,'_$1').
		// no trailing or leading dots
		replace(/\.+$|^\.+/g, '');
}

function padded_number(p) 
{
	var max = p.album.photos.length;
	var len = max.toString().length;
	var out = p.number.toString();
	while (out.length < len) {		out = '0' + out; }
	return out;
}

function log(message) 
{ // TODO: need a solution that looks better; setting value scrolls to the top, which when followed by scrolling to the bottom causes flickering
	var x = $$('#log');
	x.value += message + '\n';
	x.selectionStart = x.value.length;
	x.selectionEnd = x.value.length;
}

function ajax(url, rtype, success, failure) 
{
	var r = new XMLHttpRequest;
	r.open('GET', url, true);
	if (rtype) { r.responseType = rtype; }
	r.onload = function() 
	{
		if (r.readyState < 4) { return; }
		if (r.status >= 200 && r.status < 300) { success(r); }
		if (r.status >= 400 && r.status < 600) { failure(r); }
	};
	r.onerror = function() {		failure(r);	};
	r.send(null);
}

function new_browser() 
{
	if (browser)		{browser.parentNode.removeChild(browser);}
	browser = document.createElementNS(		'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul',		'browser');
	browser.setAttribute('type', 'content');
	oBrowserBox.appendChild(browser);
	//document.documentElement.appendChild(browser);
}

/* main actions */

function init() 
{
	console.log("O.type="+O.type);
	if (O.type == 'user_albums') { fetch_album_list(); }// autoscroll albums page before calling get_available_albums
	else {  get_available_albums(); }// call get_available_albums directly; current page is an album
	E('#albums', 'select', start_enable);
	E('#browse', 'command', browse);
	E('#start', 'command', start);
	E('#cancel', 'command', cancel);
	E('#cancelrunning', 'command', cancel);
	
	// Default Downloads dir path
	$$('#path').value = outdir.path;
}

function browse() 
{
	var p = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
	p.init(window, 'Choose a directory to download photos to', Ci.nsIFilePicker.modeGetFolder);
	if (p.show() == Ci.nsIFilePicker.returnOK) { outdir = p.file;		$$('#path').value = outdir.path; }
	start_enable();
	console.log(outdir);
}

var oBrowserBox;
function start() 
{
	O.naming = $$('#naming').selectedIndex;
	O.albumexists = $$('#albumexists').selectedIndex;
	// get_selected_albums MUST be called before hiding the lobby because when a XUL listbox is hidden, its selection state is destroyed
	get_selected_albums();
	$$('#lobby').hidden = true;
	$$('#engine').hidden = false;
	sizeToContent();
	//Add a DIV to hold all those browser objects
	oBrowserBox=document.createElement('div');
	document.documentElement.appendChild(oBrowserBox);
	
	log('Preparing to download ' + A.length + ' album' + (A.length ? 's' : '') + ':');
	A.forEach(function(a) {		a.log(a.name);	});
	log('________________________________');
	queue_poll();
	start_album(0);
}

function cancel() {	DeleteBrowserElement(oBrowserBox); close();} //TODO delete all objects first??

/* object structures */

function Album() 
{
	this.name = '';		this.url = '';
	this.outdir = null;	this.number = 0;
	this.photos = [];	this.status = 'waiting';
	this.dot = null;
	this.set_status = function(status) {		this.status = status;		this.dot.className = status;	};
	this.log = function(message) {		log('(album ' + this.number + ') ' + message);	};
}
function Photo() 
{
	this.StartLoadTime=0;
	this.pageurl = '';	this.photourl = '';
	this.album = null;	this.number = 0;
	this.video = false;	this.status = 'waiting';
	this.dot = new_progress_dot(false);
	this.set_status = function(status) 	{		this.status = status;		this.dot.className = status;		this.update_tooltip();	};
	this.update_tooltip = function() 	{		this.dot.setAttribute('tooltiptext', 'Album ' + this.album.number + ': ' + this.album.name + '\n' + 'Photo ' + this.number + ' of ' + this.album.photos.length + '\n' + 'URL: ' + (this.photourl || 'not yet known') );	};
	this.log = function(message) {		log('(album ' + this.album.number +			' photo ' + this.number + ') ' + message);	};
}
function CreateAlbum(theName,theURL) {	var a = new Album;	a.name = theName;	a.url = theURL;	return a; }
function CreatePhoto(theHref,theNumber,isVideo) {	var p = new Photo;	p.pageurl = theHref;	p.number = theNumber;	p.video = isVideo;	return p; }
//////////////////////////////////////////////////////////////////////////////////////////
function CreateBrowserElement()
{
	var retval = document.createElementNS( 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'browser');
	retval.setAttribute('type', 'content');
	oBrowserBox.appendChild(retval);
	//document.documentElement.appendChild(retval);
	return retval;
}
function DeleteBrowserElement(thebrowser){	if (thebrowser) {thebrowser.parentNode.removeChild(thebrowser);}	}
///////////////////////////////////////////////////////////////////////////////////////////

/* behind the scenes */

function new_progress_dot(is_album) 
{
	var i = Number(is_album);
	if (progress_lines_used[i] == progress_lines_max[i]) 
	{
		progress_lines[i] = document.createElement('box');
		$$('#progress_' + ['photos', 'albums'][i]).appendChild( progress_lines[i]);
		sizeToContent();
		progress_lines_used[i] = 0;
	}
	var dot = document.createElement('box');
	dot.className = 'waiting';
	progress_lines[i].appendChild(dot);
	progress_lines_used[i]++;
	return dot;
}

function start_enable() { 	$$('#start').disabled = !(album_list_available && outdir &&		$$('#albums').selectedCount); }

function get_user_name() 
{
	var c1 = $$c('.name .uiButtonText');
	var c2 = $$c('#fbProfileCover h2 a');
	var c3 = $$c('title').textContent.replace(/^[(\d)]*\s+/g,"");
	return (c1 ? c1.textContent : (c2 ? c2.textContent : (c3 ? c3 : "NONAME")));
}

function get_page_description() 
{
	switch (O.type) 
	{
		case 'album':			return get_user_name() + ' - ' + $$c('.fbPhotoAlbumTitle').textContent;
		case 'user_photos_of':	return 'Photos of ' + get_user_name();
		case 'user_photos':		return 'Photos by ' + get_user_name();
		case 'user_albums':		return 'Albums by ' + get_user_name();
	}
	return 'Unknown';
}

function fetch_album_list() 
{
	new_browser();
	console.log("Browser loading: "+C.location.toString())
	var myPListener = {};
	//{
		myPListener.QueryInterface= XPCOMUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]);
		//myPListener.onStateChange= function(aWebProgress, aRequest, aFlag, aStatus) { console.log("StateChange: "+aStatus);};
		myPListener.onLocationChange= function(aProgress, aRequest, aURI, aFlag) { console.log("LocationsChanged: "+aURI); };
		//myPListener.onProgressChange= function(aWebProgress, aRequest, curSelf, maxSelf, curTot, maxTot) {console.log("onProgressChange: "+curSelf+" / "+maxSelf+", "+curTot+" / "+maxTot+"");  };
		//myPListener.onStatusChange=function(aWebProgress, aRequest, aStatus, aMessage) { console.log("StatusChange: "+aStatus + " and\r\n"+aMessage); };
	//};
	//browser.addProgressListener(myPListener);
	//gBrowser.removeProgressListener(myListener);

	E(browser, 'DOMContentLoaded', begin_scrolling.bind( global, get_available_albums));
	E(browser, 'readystatechange', function(){ console.log("readystatechange");} );//begin_scrolling.bind( global, get_available_albums));
	E(browser, 'load', function(){ console.log("load");} );//begin_scrolling.bind( global, get_available_albums));
	console.log("Start: "+new Date().toLocaleString());
	browser.loadURI(C.location.toString());
}

function get_available_albums() 
{
	console.log("End: "+new Date().toLocaleString());
	console.log("Called get_available_albums()");
	var list = $$('#albums');
	if (O.type == 'user_albums') 
	{
		console.log("Should be looking for user albums");
		$b('li:not(.fbPhotosRedesignNavSelected) ' + '.fbPhotosRedesignNavContent').map(function(x, i, links) 
		{
			var a = new Album;
			// if the target user is a friend, most likely will be: [photos of] | [photos by]
			// if the target user is not a friend, links will be: [photos by]
			var prefix =(links.length == 1 || i == 1)?'Photos by ':'Photos of ';
			a.name = prefix + get_user_name();
			a.url = x.href;
			A.push(a);
			return a.name;
		}).forEach(function(x) 
		{
			var item = document.createElement('listitem');
			item.setAttribute('label', x);
			list.appendChild(item);
		});
		$b('.albumThumbLink').map(function(x) 
		{
			var a = new Album;
			a.name = x.parentNode.querySelector( '.photoTextTitle strong').textContent;
			a.url = x.href;
			A.push(a);
			return a.name;
		}).forEach(function(x) 
		{
			var item = document.createElement('listitem');
			item.setAttribute('label', x);
			list.appendChild(item);
		});
	} else 
	{
		console.log("NOT looking for user albums");
		var a = new Album;
		a.name = get_page_description();
		a.url = C.location.toString();
		A.push(a);
		var item = document.createElement('listitem');
		item.setAttribute('label', a.name);
		list.appendChild(item);
	}
	$$('#loading_msg').hidden = true;
	album_list_available = true;
	start_enable();
	sizeToContent();
}

function get_selected_albums() 
{
	var list = $$('#albums');
	var count = list.selectedCount;
	var selected = [];
	while (count--) 
	{
		var index = list.getIndexOfItem(list.selectedItems[count]);
		selected.push(A[index]);
		A[index].number = selected.length;
		A[index].dot = new_progress_dot(true);
	}
	A = selected;
}

function start_album(i) 
{
	var a = A[i];
	a.set_status('preparing');
	a.log('creating album folder');
	a.outdir = outdir.clone();
	var fn = sanitise_fn(a.name);
	var aid = a.url.match(/\?set=a\.(\d+)/);
	if (aid){ fn += ' (' + aid[1] + ')'; }
	a.outdir.append(fn);
	try { a.outdir.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);	} 
	catch (e) 
	{
		var error_occurred = true;
		switch (e.result) 
		{
			case Cr.NS_ERROR_FILE_NOT_FOUND:     a.log('error creating album folder: path too long'); break;
			case Cr.NS_ERROR_FILE_ACCESS_DENIED: a.log('error creating album folder: access denied'); break;
			case Cr.NS_ERROR_FILE_ALREADY_EXISTS:
				switch (O.albumexists) 
				{
					case 0: a.log('album folder exists: updating album'); error_occurred = false; break;
					case 1: a.log('album folder exists: skipping album'); break;
				}
				break;
			default: a.log('error creating album folder: ' + e.message); break;
		}
		if (error_occurred) { a.set_status('error');			Ad++;			if (A[i + 1]){ start_album(i + 1); }			return; }
	}
	a.log('fetching album index');
	new_browser();
	E(browser, 'DOMContentLoaded', begin_scrolling.bind( global, handle_album_index.bind(global, a, i)));
	browser.loadURI(a.url);
}

function begin_scrolling(callback, event) 
{
	if (event.target instanceof Ci.nsIDOMHTMLDocument && event.target != browser.contentDocument) { return; }// run once for the main document, not for frames too
	var x = 0, y = 0;
	// we previously removed the listener that triggered this function here, but even when using the theoretically perfect arguments.callee, the
	// listener never seemed to remove properly, so we now just delete and recreate a new browser element each use
	var bcw = browser.contentWindow;
	E(bcw, 'scroll', function() { y++; });
	var t = bcw.setInterval(function() 
	{
		x++;
		bcw.scrollBy(0, 50);
		if (x > y + 50) { bcw.clearInterval(t);  if (callback){ callback(); } }
	}, 100);
}

function handle_album_index(a, ai) 
{
	a.log('parsing album index');
	var bcd = browser.contentDocument;
	//CHANGES 12/12/2015 The videos aren't marked by uiVideoLink anymore, but by theater and "videso" in the url i think?
	var allLinks=bcd.querySelectorAll("a");
	var video_links=_(allLinks).filter( function(x) { return (x.rel=="theater")&&(x.href.indexOf("videos")!=-1);});
	var photo_page_links = _(bcd.querySelectorAll('a.uiMediaThumb:not(.uiMediaThumbAlb):not(.albumThumbLink)' + ', a.uiVideoLink'));
	if(photo_page_links.length==0 && video_links.length)
	{//searching is expensive and i'm already doing two of them. Some users report not having rel="theater"
		video_links=_(allLinks).filter( function(x) { return (x.href.indexOf("videos")!=-1);});
	}
	a.log('found ' + photo_page_links.length + ' photos');
	a.log('found ' + video_links.length + ' videos');
	photo_page_links.forEach(function(x) {			var p = CreatePhoto(x.href, a.photos.length+1,x.classList.contains('uiVideoLink'));			p.album = a;			P.push(p);			a.photos.push(p);		});
	video_links.forEach(function(x) {			var p = CreatePhoto(x.href, a.photos.length+1,true);			p.album = a;			P.push(p);			a.photos.push(p);		});
	a.photos.forEach(function(p) {		p.update_tooltip();	});
	a.set_status('complete');
	Ad++;
	if (A[ai + 1]){		start_album(ai + 1);}
}
function queue_poll() 
{
	if (A.length == Ad && P.length == Pd) 
	{
		log('\nAll albums and photos complete');
		$$('#cancelrunning').setAttribute('label', 'Close');
		return;
	}
	var waiting = P.filter(function(x) { return x.status == 'waiting';	});
	while (Pa < userOptions.maxPhotosAtATime && waiting.length) 
	{
		get_photo(waiting[0]);
		waiting = P.filter(function(x) { return x.status == 'waiting';		});
	}
	setTimeout(function(){queue_poll();}, 500);
}

function get_photo(p) 
{
	Pa++;
	p.set_status('preparing');
	// VIDEOs should use the ajax and then parse the page for the url
	// PHOTOs should use a brower element and wait until img.spotlight gets a hit
	if(p.video)	{ ajax(p.pageurl, 'document', handle_video_page.bind(global, p), handle_photo_page_error.bind(global, p)); }
	else { browserLoadPhotoPage(p);	}
}

function ILoadedAPage(myBrowser,p)
{
	console.log("Browser content loaded: "+p.pageurl);	
	var bcd = myBrowser.contentDocument;
	//DebugShowImages(bcd);
	var spotlightimages=bcd.querySelectorAll("img.spotlight");
	if(spotlightimages.length>=1) //TODO what if a spotlight never loads??
	{
		p.log('successfully received photo page, creating photo file');
		p.photourl=spotlightimages[0].src;
		console.log("Found my image: "+spotlightimages[0].src);
		var myuri=buildURIObject(p.photourl);
		var orig_name = myuri.pathparts[myuri.pathparts.length-1];
		DeleteBrowserElement(myBrowser);
		clearTimeout(p.tmCancel);
		downloadAFile(p,orig_name);
	}
}
function ISRFunc(strMsg,p,o)
{
	console.log("ISRFunc("+strMsg+") for p.number="+p.number+" "+(o.message||""));	
}
function browserLoadPhotoPage(p)
{
	var myBrowser = CreateBrowserElement();//browser;
	E(myBrowser, 'DOMContentLoaded',function(event){ ILoadedAPage(myBrowser,p); } );
	E(myBrowser, 'load',function(event){ISRFunc("load",p,event); } );
	E(myBrowser, 'abort',function(event){ISRFunc("abort",p,event); } );
	E(myBrowser, 'error',function(event){ISRFunc("error",p,event); } );
	E(myBrowser, 'loadend',function(event){ISRFunc("loadend",p,event); } );
	p.StartLoadTime=new Date();
	p.tmCancel=setTimeout(function(){ cancelBrowerPage(myBrowser,p); }, userOptions.maxTimeToSearchForImageMS);//what if i attached an setTimeout() that worked as a canel button?
	myBrowser.loadURI(p.pageurl);	
}
function cancelBrowerPage(aBrowser,p)
{
	console.log("cancelBrowerPage() called for p.number="+p.number);
	handle_photo_page_error(p,{status:"Timeout searching for photo file"});
	DeleteBrowserElement(aBrowser);
	//p.log('Timeout searching for photo file');	
}

function handle_video_page(p, r) 
{
	p.log('successfully received photo page, creating photo file');
	var hdmatch = r.response.body.innerHTML.match( /hd_src\\u002522\\u00253A\\u002522(.*?)\\u002522/);
	var sdmatch = r.response.body.innerHTML.match( /sd_src\\u002522\\u00253A\\u002522(.*?)\\u002522/);//document.querySelectorAll("video")[0].src; //only gets SD
	p.photourl = decodeURIComponent(JSON.parse( '"' + (hdmatch || sdmatch)[1] + '"')).			replace(/\\/g, '');
	var myVideoURL=buildURIObject(p.photourl);
	var orig_name = myVideoURL.pathparts[myVideoURL.pathparts.length-1];
	downloadAFile(p,orig_name);
}
function downloadAFile(p,orig_name)
{
	p.set_status('downloading');
	p.outfile = p.album.outdir.clone();
	switch (O.naming) 
	{
		case 0:		p.outfile.append(sanitise_fn(padded_number(p) + (p.video ? '.mp4' : '.jpg')));		break;		// as of current knowledge, all videos are .mp4 and all photos are .jpg
		case 1:		p.outfile.append(sanitise_fn(orig_name));		break;
		case 2:		p.outfile.append(sanitise_fn(padded_number(p) + '_' + orig_name));		break;
	}
	//console.log("orig_name="+orig_name); 	console.log("File Target: "+p.outfile.target);	
	try 
	{	
		//var bExists=p.outfile.exists();				p.log("Creating file: ["+p.outfile.target+"] "+bExists+", "+"")
		p.outfile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0644);	
	} 
	catch (e) 
	{	
		switch (e.result) 
		{
			case Cr.NS_ERROR_FILE_NOT_FOUND:		p.log('error creating photo file: path too long: ' + e.message);			break;
			case Cr.NS_ERROR_FILE_ACCESS_DENIED:	p.log('error creating photo file: access denied');			break;
			case Cr.NS_ERROR_FILE_ALREADY_EXISTS:	p.log('error creating photo file: file exists');			break;
			default:								p.log('error creating photo file: ' + e.message);			break;
		}
		p.set_status('error');		Pa--;		Pd++;
		return;
	}

	//	var ios = Cc["@mozilla.org/network/io-service;1"].getService(Ci.nsIIOService);
	//	var aSource=ios.newURI(p.photourl, null, null);
	//	var aTarget=p.outfile;//this is an nsIFile
	//	var aOptions={isPrivate:true};//set to false to have it show up in download history?
	//DownloadFile.fetch(  aSource,  aTarget,  Object aOptions);
	
	// createDownload() is supposed to take an object with all the serialize-able stuff from here:
	//https://dxr.mozilla.org/mozilla-central/source/toolkit/components/jsdownloads/src/DownloadCore.jsm
	
	var aProperties = 	{		source: {url:p.photourl, isPrivate:!userOptions.showPhotosInDownloadHistory},		target: p.outfile	};	

	var promDownloader = Downloads.createDownload(aProperties);
	promDownloader.then(
		function(val)  //promiseobj.then(onFulfilled, onRejected);
		{
			var promStart = val.start();
			promStart.then(
				function(fulfilment) { handle_photo_success(p); },//fulfilment
				function(reason) { console.log(reason);handle_photo_error(p,{responseStatus:500,responseStatusText:"Unknown Error (facepaste downloading)"}); }//rejection
			);
		},
		function(failVal) { handle_photo_error(p,{responseStatus:500,responseStatusText:"Unknown Error (facepaste creating API download)"}); }
	);
}

function handle_photo_page_error(p, r) {	if (r.status){ p.log('failed to download photo page: error ' + r.status); }	else{ p.log('failed to download photo page: connection error'); }	p.set_status('error');	Pa--;	Pd++;}
function handle_photo_success(p) {	p.log('finished downloading photo file');	p.set_status('complete');	Pa--;	Pd++; }
function handle_photo_error(p, chan) {	p.log('failed to download photo file: ' + chan.responseStatus + ' ' + chan.responseStatusText);	p.set_status('error');	Pa--;	Pd++;}

E(global, 'load', init);

})(this);
