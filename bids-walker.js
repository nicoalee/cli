#!/usr/bin/env node

"use strict";

//this module walks bids directory structure and construct a list of brainlife dataset structures with all the appropriate metadata

const fs = require('fs');
const async = require('async');
const path = require('path');
const util = require('./util');

//sub-CC510395_ses-001_T1w.nii.gz
function parseBIDSPath(_path) {
    let obj = {_fullname: _path};
    let base = path.basename(_path);
    let parts = base.split("_");
    parts.forEach(part=>{
        let tokens = part.split("-");
        if(tokens.length == 1) {
            obj._filename = tokens[0];
        }
        if(tokens.length > 1) {
            obj[tokens[0]] = tokens.splice(1).join("-");
        }
    });
    return obj;
}

exports.walk = (root, cb)=>{
    let bids = {
        README: null,
        CHANGES: null,
        dataset_description: {},
        participants: [], //from participants.tsv
        participants_json: null, //from participants.json
        datasets: [], //{dataset, files} ... you have to do dataset.dataset.meta... maybe I should rename it to items"
    }

    let tsv = null;
    if(fs.existsSync(root+"/participants.tsv")) {
        tsv = fs.readFileSync(root+"/participants.tsv", "utf8").trim().split("\n");
    }
    if(fs.existsSync(root+"/participant_data.tsv")) {
        tsv = fs.readFileSync(root+"/participant_data.tsv", "utf8").trim().split("\n");
    }
    if(tsv) bids.participants = util.parseParticipantTSV(tsv);

    try {
        if(fs.existsSync(root+"/participants.json")) {
            let json = fs.readFileSync(root+"/participants.json", "utf8");
            bids.participants_json = util.escape_dot(JSON.parse(json));
        }
    } catch(err) {
        console.error(err);
        console.error("failed to parse participants.json.. ignoring");
        ///mnt/datalad/datasets.datalad.org/openfmri/ds000201 contains participants.json that's basically the participants.tsv
    }

    //TODO - should I create a default participants.json if it's missing so that brainlife UI will at least show each columns?

    if(fs.existsSync(root+"/README")) {
        bids.README = fs.readFileSync(root+"/README", "utf8");
    }
    if(fs.existsSync(root+"/CHANGES")) {
        bids.CHANGES = fs.readFileSync(root+"/CHANGES", "utf8");
    }
    if(fs.existsSync(root+"/dataset_description.json")) {
        let json = fs.readFileSync(root+"/dataset_description.json");
        bids.dataset_description = JSON.parse(json);
        if(Array.isArray(bids.dataset_description.HowToAcknowledge)) {
            //ds000222 is storing this as array..
            bids.dataset_description.HowToAcknowledge = bids.dataset_description.HowToAcknowledge.toString();
        }
    }
    
    //start iterating subject directory
    fs.readdir(root, (err, paths)=>{
        if(err) throw err;

        //first load all sidecars at root level
        let common_sidecar = {};  //key: task-shape_bold.json value: content
        async.eachSeries(paths, (path, next_path)=>{
            if(path.startsWith(".")) return next_path();

            if(path.endsWith(".json")) { //load things like root level task-XXX_bold.json
                //console.log("loading root level sidecar:"+path);
                try {
                    let json = fs.readFileSync(root+"/"+path);
                    common_sidecar[path] = JSON.parse(json);
                } catch(err) {
                    console.error("failed to parse "+root+"/"+path);
                    console.error(err);
                }
            }
            return next_path();
        }, async err=>{
            if(err) return cb(err);  

            //then load derivatives
            const derivatives = await loadDerivatives(root);
            
            //then handle subjects
            async.eachSeries(paths, (path, next_path)=>{
                try {
                    const stats = fs.statSync(root+"/"+path);
                    if(!stats.isDirectory()) return next_path(); 
                } catch (err) {
                    //probably broken link?
                    return next_path();
                }

                if(path == "derivatives") return next_path();
                
                //mnust be a real subject directory
                let fileinfo = parseBIDSPath(path);
                if(!fileinfo['sub']) {
                    console.error("couldn't find subject directory.. not bids root? "+path);
                    return next_path();
                }
                handle_subject(derivatives, common_sidecar, root+"/"+path, next_path);
            }, err=>{
                //all done load bids

                //escape "."(dot) inside meta
                //uncaughtException: key PVTMotivation1.1 must not contain '.'
                bids.datasets.forEach(dataset=>{
                    util.escape_dot(dataset.dataset.meta);
                });

                cb(err, bids);
            });
        });
    });

    function loadDerivatives(root) {
        return new Promise(async (resolve, reject) => {
            if(!fs.existsSync(root+"/derivatives")) {
                console.log("no derivatives, or not accessible");
                return resolve(null);
            }

            const derivatives = [];
            const pipelines = await fs.promises.readdir(root+"/derivatives");
            async.eachSeries(pipelines, async pipeline=>{
                const subjects = await fs.promises.readdir(root+"/derivatives/"+pipeline);
                await async.eachSeries(subjects, async subject=>{
                    //TODO - does derivative has ses- between sub-/ and modality?
                    //if so, we need to iterate over it
                    if(!subject.startsWith("sub-")) {
                        console.error("derivative directory under pipeline doesn't look like properly formatted subject directory (ignoring):"+subject);
                        return;
                    }
                    const path = root+"/derivatives/"+pipeline+"/"+subject;
                    const subDerivatives = await loadDerivativesModality(path, pipeline, subject.substring(4));
                    subDerivatives.forEach(d=>derivatives.push(d));
                });
            }, err=>{
                if(err) return reject(err);
                resolve(derivatives);
            }); 
        });
    }

    //group files with same bids entities
    function groupFiles(_path, files) {
        //group objects
        let groups = {}; 
        files.forEach((file)=>{
            if(file.startsWith(".")) return;
            let fileinfo = parseBIDSPath(file);
            fileinfo._path = _path;
            let key = [] 
            for(let k in fileinfo) {
                if(k[0] == "_") continue; //ignore filename/fullname
                key.push(k+"-"+fileinfo[k]);
                //key += fileinfo._filename.split(".")[0]; //T1w, T2w, etc.
            }
            key = key.join(".");
            if(!groups[key]) groups[key] = {infos: []};
            groups[key][fileinfo._filename] = groups[key].infos.length;
            groups[key].infos.push(fileinfo);
        });
        return groups;
    }

    function loadDerivativesModality(path, pipeline, subject, session = null) {
        return new Promise(async (resolve, reject) => {
            const derivatives = [];
            const modalities = await fs.readdirSync(path);
            async.eachSeries(modalities, async modality=>{
                const files = await fs.readdirSync(path+"/"+modality);
                const groups = groupFiles(path+"/"+modality, files);
                for(let key in groups) {
                    derivatives.push(Object.assign({
                        key: [subject, session, modality].join("."),
                        pipeline, 
                    }, groups[key]));
                }
                return derivatives;
            }, err=>{
                if(err) return reject(err);
                resolve(derivatives);
            });
        });
    }

    async function handle_subject(derivatives, parent_sidecar, _path, cb) {
        //copy all sidecar from parent
        let common_sidecar = {};
        for(let path in parent_sidecar) {
            common_sidecar[path] = Object.assign({}, parent_sidecar[path]);
        }
        
        const dirs = await fs.readdirSync(_path);

        //first handle sidecars at subject level
        async.forEach(dirs, (dir, next_dir)=>{
            if(dir.startsWith(".")) return next_dir();
            if(dir.endsWith(".json")) {
                try {
                    let json = fs.readFileSync(_path+"/"+dir);
                    let sidecar = JSON.parse(json);
                    if(!common_sidecar[dir]) common_sidecar[dir] = sidecar;
                    else for(let key in sidecar) common_sidecar[dir][key] = sidecar[key]; //need to replace parent's value
                } catch(err) {
                    console.error("failed to parse subject level json: "+_path+"/"+dir);
                    console.error(err);
                }
            }
            next_dir();
        }, err=>{
            if(err) return cb(err);  
            //then handle modality or session
            async.forEach(dirs, (dir, next_dir)=>{
                if(dir.startsWith(".")) return next_dir();
                if(dir.indexOf("ses-") == 0) return handle_subject(derivatives, common_sidecar, _path+"/"+dir, next_dir);

                switch(dir) {
                case "anat": 
                    handle_anat(derivatives, common_sidecar, _path+"/anat", next_dir);
                    break;
                case "dwi": 
                    handle_dwi(derivatives, common_sidecar, _path+"/dwi", next_dir);
                    break;
                case "func": 
                    handle_func(derivatives, common_sidecar, _path+"/func", next_dir);
                    break;
                case "fmap": 
                    handle_fmap(derivatives, common_sidecar, _path+"/fmap", next_dir);
                    break;
                case "eeg": 
                    handle_eeg(derivatives, common_sidecar, _path+"/eeg", next_dir);
                    break;
                case "meg": 
                    handle_meg(derivatives, common_sidecar, _path+"/meg", next_dir);
                    break;
                default:
                    next_dir();
                }
            }, cb);
        });
    }

    function get_meta(fileinfo) {
        let meta = {};
        for(let key in fileinfo) {
            let inkey = key;

            //ignore some keys (like _filename, _fullname..)
            if(key[0] == "_") continue;

            //some structural keys are stored under different names on brainlife
            if(key == "sub") inkey = "subject";
            if(key == "ses") inkey = "session";

            //not sure if I should have these yet..
            //if(key == "acq") inkey = "acquisition";

            meta[inkey] = fileinfo[key];
        }
        return meta;
    }

    function get_tags(fileinfo) {
        let tags = [];
        for(let key in fileinfo) {
            //if(key == "_filename") continue;
            //if(key == "_fullname") continue;
            if(key[0] == "_") continue;

            //ignore some structural tag as they will be stored in metadata
            if(key == "sub") continue;
            if(key == "ses") continue;

            //we want run to be stored in tag.. as it will be important to setup rules
            
            //store other things as tag
            tags.push(key+"-"+fileinfo[key]);
        }
        return tags;
    }

    function handle_dwi(derivatives, parent_sidecar, _path, cb) {
        fs.readdir(_path, (err, files)=>{
            if(err) return cb(err);
            async.forEach(files, (file, next_file)=>{
                if(file.startsWith(".")) return next_file();

                let fileinfo = parseBIDSPath(file);
                switch(fileinfo._filename) {
                case "dwi.nii":
                case "dwi.nii.gz":
                    //let sidecar_name = fullname.substring(0, fullname.length-7)+".json"; //remove .nii.gz to replace it with .json
                    //let sidecar = get_sidecar(_path+"/"+sidecar_name);
                    let sidecar = {};
                    Object.assign(sidecar, parent_sidecar["dwi.json"]);
                    Object.assign(sidecar, get_sidecar_from_fileinfo(_path, fileinfo, "dwi.json"));

                    let dataset = {
                        datatype: "neuro/dwi",
                        desc: fileinfo._fullname,
                        
                        datatype_tags: [],
                        tags: get_tags(fileinfo),

                        meta: Object.assign(sidecar, get_meta(fileinfo)),
                    }

                    let basename = get_basename(fileinfo);
                    let files = {
                        "dwi.nii.gz": _path+"/"+fileinfo._fullname,
                        "dwi.bvecs": _path+"/"+basename+"dwi.bvec",
                        "dwi.bvals": _path+"/"+basename+"dwi.bval",
                    };
                        
                    //TODO - sbref.json could be stored on the parent directory without hierarchy.. 
                    let sbref_fullname = _path+"/"+basename+"sbref.nii.gz"; 
                    if(fs.existsSync(sbref_fullname)) {
                        files["sbref.nii.gz"] = sbref_fullname;
                    }
                    let sbrefjson_fullname = _path+"/"+basename+"sbref.json"; 
                    if(fs.existsSync(sbrefjson_fullname)) {
                        files["sbref.json"] = sbrefjson_fullname;
                    }

                    bids.datasets.push({dataset, files});
                    next_file(); 
                    break;
                default:
                    next_file();
                }
            }, cb);
        });
    }

    async function handle_anat(derivatives, parent_sidecar, _path, cb) {
        const files = fs.readdirSync(_path);

        //group mp2rage files (ignore inv-)
        //almost the same with groupFile() but we need to ignore inv-
        let groups = {}; 
        files.forEach(file=>{
            if(file.startsWith(".")) return;
            let fileinfo = parseBIDSPath(file);
            let key = "";
            for(let k in fileinfo) {
                if(k[0] == "_") continue; //ignore filename/fullname
                //ignore inv when grouping fior mp2rage
                if(fileinfo._filename.startsWith("MP2RAGE") && k == "inv") continue; 
                key += k+"-"+fileinfo[k];
                key += fileinfo._filename.split(".")[0]; //T1w, T2w, etc.
            }
            if(!groups[key]) groups[key] = {infos: []};
            groups[key][fileinfo._filename] = groups[key].infos.length;
            groups[key].infos.push(fileinfo);
        });
            
        //now handle mp2rage groups
        async.eachOfSeries(groups, (group, key, next_group)=>{
            if(group["T1w.nii.gz"]) {
                const idx = group["T1w.nii.gz"];
                const fileinfo = group.infos[idx];
                return handle_anat_t1(derivatives, parent_sidecar, _path, fileinfo, next_group);
            }
            if(group["T2w.nii.gz"]) {
                const idx = group["T2w.nii.gz"];
                const fileinfo = group.infos[idx];
                return handle_anat_t2(derivatives, parent_sidecar, _path, fileinfo, next_group);
            }
            if(group["FLAIR.nii.gz"]) {
                const idx = group["FLAIR.nii.gz"];
                const fileinfo = group.infos[idx];
                return handle_anat_flair(derivatives, parent_sidecar, _path, fileinfo, next_group);
            }
            if(group["MP2RAGE.nii.gz"]) {
                const idx = group["MP2RAGE.nii.gz"];
                const fileinfo = group.infos[idx];
                return handle_anat_mp2rage(derivatives, parent_sidecar, _path, group.infos, next_group);
            }
            next_group();
        }, cb);
    }

    function handle_fmap(derivatives, parent_sidecar, _path, cb) {
        const files = fs.readdirSync(_path);

        let groups = {}; 
        
        //group files by sub/ses/acq/run
        files.forEach(file=>{
            if(file.startsWith(".")) return;
            let fileinfo = parseBIDSPath(file);
            let key = "";
            if(fileinfo.sub) key += "sub-"+fileinfo.sub;
            if(fileinfo.ses) key += "ses-"+fileinfo.ses;
            if(fileinfo.run) key += "run-"+fileinfo.run;
            if(fileinfo.acq) key += "acq-"+fileinfo.acq;
            if(!groups[key]) groups[key] = {infos: []};
            groups[key][fileinfo._filename] = groups[key].infos.length;
            groups[key].infos.push(fileinfo);
        });

        //Some fmap/pepolar uses different run- but we don't want to split them into different 
        //groups/objects. Instead of using the nornmal BIDS path, We could rely on IntendedFor 
        //to tell us which set of files really belongs to each other. 
        //If 2 groups shares the same IntendedFor, we can assume that they should probably be merged together
        //To do that, we first need to load the IntendedFor from the .json
        //then, we use that as the new grouping key and merge .infos array
        let groups_merged = {};
        for(let key in groups) {
            let group = groups[key];
            //look for pepolar and load intendedFor array
            if(group["epi.nii.gz"]) { 
                let intendedFor = null;
                group.infos.forEach(info=>{
                    if(info._filename == "epi.json") {
                        let sidecar = get_sidecar(_path+"/"+info._fullname);
                        if(sidecar) intendedFor = sidecar.IntendedFor;
                    }
                });

                if(!intendedFor) {
                    //if intendedFor isn't filled, then don't group!
                    groups_merged[key] = group;
                } else {
                    //we have intended for! use it to group together instead of original key
                    let inFor = JSON.stringify(intendedFor);
                    if(groups_merged[inFor]) {
                        //merge!
                        groups_merged[inFor].infos = [...groups_merged[inFor].infos, ...group.infos];
                        //console.log("merged", inFor, groups_merged[inFor].infos);
                    } else {
                        //new!
                        groups_merged[inFor] = group;
                        //console.log("new group", inFor)
                    }
                }
            } else {
                //not pepolar .. just keep it separate
                //TODO - maybe we wwant to group other field map files to be grouped also?
                groups_merged[key] = group;
            }
        }

        //for each group, load appropriate datatype
        async.eachOfSeries(groups_merged, (group, key, next_group)=>{
            //a single group might contain multiple fmap objects.. 
            async.series([
                next=>{
                    if(group["fieldmap.nii.gz"]) handle_fmap_single(derivatives, parent_sidecar, _path, group.infos, next);
                    else next();
                },
                next=>{
                    if(group["phasediff.nii.gz"]) handle_fmap_phasediff(derivatives, parent_sidecar, _path, group.infos, next);
                    else next();
                },
                next=>{
                    if(group["phase1.nii.gz"]) handle_fmap_2phasemag(derivatives, parent_sidecar, _path, group.infos, next);
                    else next();
                },
                next=>{
                    if(group["epi.nii.gz"]) handle_fmap_pepolar(derivatives, parent_sidecar, _path, group.infos, next);
                    else next();
                },
                next=>{
                    if(group["epi.bvec"]) handle_fmap_b0(derivatives, parent_sidecar, _path, group.infos, next); //"5th fieldmap..
                    else next();
                },
            ], next_group);
        }, cb)
    }

    function handle_fmap_single(derivatives, parent_sidecar, dir, infos, cb) {
        let fileinfo = infos.find(info=>info._filename == "fieldmap.nii.gz");
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["fieldmap.json"]);
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, fileinfo, "fieldmap.json"));

        let dataset = {
            datatype: "neuro/fmap",
            desc: fileinfo._fullname,
            
            datatype_tags: ["single"],
            tags: get_tags(fileinfo),

            meta: Object.assign(sidecar, get_meta(fileinfo)),
        }

        let files = {};
        infos.forEach(info=>{
            if(info._filename.startsWith("fieldmap.") || info._filename.startsWith("magnitude.")) {
                files[info._filename] = dir+"/"+info._fullname;
            }
        });
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_fmap_2phasemag(derivatives, parent_sidecar, dir, infos, cb) {
        let fileinfo1 = infos.find(info=>info._filename == "phase1.nii.gz");
        let fileinfo2 = infos.find(info=>info._filename == "phase2.nii.gz");

        if(!fileinfo1 || !fileinfo2) {
            console.error("2phasemag given with only phase1?");
            console.dir(infos);
            return cb();
        }

        let sidecar = {};
        //Object.assign(sidecar, parent_sidecar["phase.json"]); //not sure if this is it..
        Object.assign(sidecar, 
            get_sidecar_from_fileinfo(dir, fileinfo1, "phase1.json"),  //is this right?
            get_sidecar_from_fileinfo(dir, fileinfo2, "phase2.json")); //is this right?

        let dataset = {
            datatype: "neuro/fmap",
            desc: fileinfo1._fullname+" and "+fileinfo2._fullname,
            
            datatype_tags: ["2phasemag"],
            tags: [...new Set([...get_tags(fileinfo1), ...get_tags(fileinfo2)])],

            meta: Object.assign(sidecar, get_meta(fileinfo1), get_meta(fileinfo2)),
        }

        let files = {};
        infos.forEach(info=>{
            if(info._filename.startsWith("phase1.") || info._filename.startsWith("magnitude1.") ||
               info._filename.startsWith("phase2.") || info._filename.startsWith("magnitude2.")) {
                files[info._filename] = dir+"/"+info._fullname;
            }
        });
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_fmap_phasediff(derivatives, parent_sidecar, dir, infos, cb) {
        let pd_fileinfo = infos.find(info=>info._filename == "phasediff.nii.gz");
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["phasediff.json"]);
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, pd_fileinfo, "phasediff.json"));

        let dataset = {
            datatype: "neuro/fmap",
            desc: pd_fileinfo._fullname,
            
            datatype_tags: ["phasediff"],
            tags: get_tags(pd_fileinfo),

            meta: Object.assign(sidecar, get_meta(pd_fileinfo)),
        }

        let files = {};
        infos.forEach(info=>{
            if(info._filename.startsWith("phasediff.") || info._filename.startsWith("magnitude1.") || info._filename.startsWith("magnitude2")) {
                files[info._filename] = dir+"/"+info._fullname;
            }
        });
        bids.datasets.push({dataset, files});
        cb();
    }

    //return array of 3 objects.
    //0: items that are common in both. 
    //1: diffrent items for A, 
    //2: different items for B
    function object_diff(a, b) {
        let same = {};
        let diff_a = {};
        let diff_b = {};
        for(let key in a) {
            let av = a[key];
            let bv = b[key];
            if(Array.isArray(av) && av == bv.toString()) same[key] = av;
            else if(av == bv) same[key] = av;
            else {
                diff_a[key] = av;
                diff_b[key] = bv;
            }
        }

        //look for things that only exists in b
        for(let key in b) {
            if(a[key] === undefined) {
                diff_a[key] = null; //should I?
                diff_b[key] = b[key];
            }
        }
        return {same, a: diff_a, b: diff_b};
    }

    function handle_fmap_b0(derivatives, parent_sidecar, dir, infos, cb) {
        /*
        { infos:
           [ { _fullname: 'sub-C01087_ses-01_dir-PA_run-01_epi.bval',
               sub: 'C01087',
               ses: '01',
               dir: 'PA',
               run: '01',
               _filename: 'epi.bval' },
             { _fullname: 'sub-C01087_ses-01_dir-PA_run-01_epi.bvec',
               sub: 'C01087',
               ses: '01',
               dir: 'PA',
               run: '01',
               _filename: 'epi.bvec' },
             { _fullname: 'sub-C01087_ses-01_dir-PA_run-01_epi.json',
               sub: 'C01087',
               ses: '01',
               dir: 'PA',
               run: '01',
               _filename: 'epi.json' },
             { _fullname: 'sub-C01087_ses-01_dir-PA_run-01_epi.nii.gz',
               sub: 'C01087',
               ses: '01',
               dir: 'PA',
               run: '01',
               _filename: 'epi.nii.gz' } ],
          'epi.bval': true,
          'epi.bvec': true,
          'epi.json': true,
          'epi.nii.gz': true }
        */

        let epi = infos.find(info=>{return (info._filename == "epi.nii.gz")});
        let bvec = infos.find(info=>{return (info._filename == "epi.bvec")});
        let bval = infos.find(info=>{return (info._filename == "epi.bval")});

        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["epi.json"]); //is this right?
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, epi, "epi.json"));

        let dataset = {
            datatype: "neuro/dwi",
            desc: epi._fullname,
            
            datatype_tags: [], 

            //tags: get_tags(epi),
            tags: [ "fmap", "b0", epi.dir ],

            meta: Object.assign(sidecar, get_meta(epi)),
        }

        let files = {
            "dwi.nii.gz": dir+"/"+epi._fullname,
            "dwi.bvecs": dir+"/"+bvec._fullname,
            "dwi.bvals": dir+"/"+bval._fullname,
        };
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_fmap_pepolar(derivatives, parent_sidecar, dir, infos, cb) {
        /* infos
        [ { _fullname: 'sub-01_dir-ap_epi.json',
            sub: '01',
            dir: 'ap',
            _filename: 'epi.json' },
          { _fullname: 'sub-01_dir-ap_epi.nii.gz',
            sub: '01',
            dir: 'ap',
            _filename: 'epi.nii.gz' },
          { _fullname: 'sub-01_dir-pa_epi.json',
            sub: '01',
            dir: 'pa',
            _filename: 'epi.json' },
          { _fullname: 'sub-01_dir-pa_epi.nii.gz',
            sub: '01',
            dir: 'pa',
            _filename: 'epi.nii.gz' } ]
        */
        let sidecar = {};
        
        //count number of dirs
        let dirs = [];
        infos.forEach(info=>{
            if(!dirs.includes(info.dir)) dirs.push(info.dir);
            if(info._filename == "epi.json") {
                Object.assign(sidecar, parent_sidecar["epi.json"]);
                Object.assign(sidecar, get_parent_sidecar(parent_sidecar, info._filename));
                Object.assign(sidecar, get_sidecar(dir+"/"+info._fullname));
            }
        });

        //create epiN.json, etc..
        let files = {};
        let all_tags = [];
        let meta = {};
        infos.forEach(info=>{
            let id = dirs.indexOf(info.dir) + 1;
            if(info._filename == "epi.json") {
                files["epi"+id+".json"] = dir+"/"+info._fullname;
            }
            if(info._filename == "epi.nii.gz") {
                files["epi"+id+".nii.gz"] = dir+"/"+info._fullname;
                let tags = get_tags(info);
                meta = get_meta(info);
                all_tags = Array.from(new Set([...all_tags, ...tags]));
            }
        });

        delete meta.dir;

        let dataset = {
            datatype: "neuro/fmap",
            //desc: first_fileinfo._fullname,

            datatype_tags: ["pepolar"],
            tags: all_tags,
            //meta: Object.assign(meta_same, {ap: meta_ap, pa: meta_pa}, get_meta(ap_fileinfo)),
            meta: Object.assign(sidecar, meta),
        }

        bids.datasets.push({dataset, files});

        cb();
    }

    //deprecated by get_parent_sidecar()
    //convert 
    //  sub-01_ses-01_task-ClipsVal05_acq-ap_bold.json
    //to 
    //  task-ClipsVal05_acq-ap_bold.json

    //look for parent sidecars that belongs to the sidecar filename
    function get_parent_sidecar(parent_sidecars, filename) {

        let tokens = filename.split("_");
        function strip_token(hie) {
            let found;
            tokens.forEach((token, idx)=>{
                if(token.startsWith(hie)) {
                    found = idx;
                }
            });
            if(found !== undefined) tokens.splice(found, 1);
        }
        
        //look for json with no run  
        const sidecar = {};

        strip_token("run-"); 
        filename = tokens.join("_");
        if(parent_sidecars[filename]) {
            console.debug("using", filename);
            sidecar = Object.assign({}, parent_sidecars[filename], sidecar);
        }

        strip_token("ses-"); 
        filename = tokens.join("_");
        if(parent_sidecars[filename]) {
            console.debug("using", filename);
            sidecar = Object.assign({}, parent_sidecars[filename], sidecar);
        }

        strip_token("sub-"); 
        filename = tokens.join("_");
        if(parent_sidecars[filename]) {
            console.debug("using", filename);
            sidecar = Object.assign({}, parent_sidecars[filename], sidecar);
        }

        return sidecar;
    }

    function handle_eeg(derivatives, parent_sidecar, _path, cb) {
        const files = fs.readdirSync(_path);
        const groups = groupFiles(_path, files);
        async.eachOfSeries(groups, (group, key, next_group)=>{
            const fileinfo = group.infos[0];
            const basename = get_basename(fileinfo);
            const files = {};

            //guess datatype from certain key files
            let datatype;
            if(group["eeg.bdf"]) {
                datatype = "neuro/eeg/bdf"
            } else if(group["eeg.edf"]) {
                datatype = "neuro/eeg/edf"
            } else if(group["eeg.eeg"]) {
                datatype = "neuro/eeg/brainvision"
            } else if(group["eeg.fdt"]) {
                datatype = "neuro/eeg/eeglab"
            } else {
                return next_group(); 
            }
            
            let sidecar = {};

            //set files for the group
            group.infos.forEach(fileinfo=>{
                const fullpath = _path+"/"+fileinfo._fullname;
                switch(fileinfo._filename) {
                case "eeg.json":
                    const basename = get_basename(fileinfo);
                    const sidecar_name = basename+"meg.json"; 
                    //compose sidecar
                    Object.assign(sidecar, parent_sidecar["eeg.json"]);
                    Object.assign(sidecar, get_parent_sidecar(parent_sidecar, sidecar_name));
                    Object.assign(sidecar, get_sidecar(fullpath));
                default:
                    files[fileinfo._filename] = fullpath;
                }
            });

            let dataset = {
                datatype,
                desc: key,
                datatype_tags: [ fileinfo.task.toLowerCase() ],  //should I really do this?
                tags: get_tags(fileinfo),
                meta: Object.assign(sidecar, get_meta(fileinfo)),
            }

            //load common files that applies across groups
            //TODO - I think I should skip sibling group with full bids entities?
            for(const key in groups) {
                const group = groups[key];
                group.infos.forEach(fileinfo=>{
                    const path = _path+"/"+fileinfo._fullname;
                    if(!files["coordsystem.json"] && fileinfo._filename == "coordsystem.json") {
                        files["coordsystem.json"] = path;
                    }
                    if(!files["electrodes.tsv"] && fileinfo._filename == "electrodes.tsv") {
                        files["electrodes.tsv"] = path;
                    }
                    if(!files["headshape.pos"] && fileinfo._filename == "headshape.pos") {
                        files["headshape.pos"] = path;
                    }
                });
            }

            console.log("adding files go eeg dataset");
            console.dir(files);
            bids.datasets.push({dataset, files});
            next_group();
        }, cb);
    }

    async function handle_meg(derivatives, parent_sidecar, _path, cb) {
        const files = fs.readdirSync(_path);
        const groups = groupFiles(_path, files);
        async.eachOfSeries(groups, (group, key, next_group)=>{
            const fileinfo = group.infos[0];
            const files = {};
            let datatype;
            if(group["meg.ds"] && fileinfo.task) {
                datatype = "neuro/meg/ctf";
                //TODO - I don't think setting it to directory will work.. but maybe it's downstream issue. let'sd see
            } else if(group["meg.fif"] && fileinfo.task) {
                datatype = "neuro/meg/fif";
            } else {
                return next_group(); 
            }

            group.infos.forEach(fileinfo=>{
                const fullpath = _path+"/"+fileinfo._fullname;
                /*
                if(fileinfo._filename == "meg.ds") files["meg.ds"] = fullpath;
                if(fileinfo._filename == "meg.fif") files["meg.fif"] = fullpath;
                if(fileinfo._filename == "channels.tsv") files["channels.tsv"] = fullpath;
                if(fileinfo._filename == "events.tsv") files["events.tsv"] = fullpath;
                if(fileinfo._filename == "events.json") files["events.json"] = fullpath;
                */
                switch(fileinfo._filename) {
                case "meg.dat":
                    if(ginfo._acq == "calibration") files["calibration_meg.dat"] = fullpath;
                    break;
                case "meg.fif":
                    if(ginfo._acq == "crosstalk") files["crosstalk_meg.fif"] = fullpath;
                    break;
                case "meg.json":
                    //compose sidecar
                    let basename = get_basename(fileinfo);
                    let sidecar_name = basename+"meg.json"; 
                    let sidecar = {};
                    Object.assign(sidecar, parent_sidecar["meg.json"]);
                    Object.assign(sidecar, get_parent_sidecar(parent_sidecar, sidecar_name));
                    Object.assign(sidecar, get_sidecar(_path+"/"+sidecar_name));
                    break;
                default:
                    files[fileinfo._filename] = fullpath;
                }
            });

            let dataset = {
                datatype,
                desc: key,
                datatype_tags: [ fileinfo.task.toLowerCase() ],  //should I really do this?
                tags: get_tags(fileinfo),
                meta: Object.assign(sidecar, get_meta(fileinfo)),
            }

            //load common files that belongs across groups
            //TODO - I think I should skip sibling group with full bids entities?
            for(const key in groups) {
                const group = groups[key];
                group.infos.forEach(fileinfo=>{
                    console.dir(fileinfo);
                    const path = _path+"/"+fileinfo._fullname;
                    if(!files["coordsystem.json"] && fileinfo._filename == "coordsystem.json") {
                        files["coordsystem.json"] = path;
                    }
                    if(!files["electrodes.tsv"] && fileinfo._filename == "electrodes.tsv") {
                        files["electrodes.tsv"] = path;
                    }
                    if(!files["headshape.pos"] && fileinfo._filename == "headshape.pos") {
                        files["headshape.pos"] = path;
                    }
                    if(!files["calibration_meg.dat"] && fileinfo._filename == "meg.dat" && fileinfo.acq == "calibration") {
                        files["calibration_meg.dat"] = path;
                    }
                    if(!files["crosstalk_meg.fif"] && fileinfo._filename == "meg.fif" && fileinfo.acq == "crosstalk") {
                        files["crosstalk_meg.fif"] = path;
                    }
                });

                /*
                //not tested..
                if(group["destination.fif"]) {
                    let ginfo = group.infos[0];
                    if(ginfo._acq = "destination") files["destination.dif"] = _path+"/"+ginfo._fullname;
                }
                */
            }

            bids.datasets.push({dataset, files});
            next_group(); 
        }, cb);
    }

    //converts /something-123_another-123_bold.nii.gz to
    //         /something-123_another-123
    function get_basename(fileinfo) {
        return fileinfo._fullname.substring(0, fileinfo._fullname.length-fileinfo._filename.length);
    }

    function handle_func(derivatives, parent_sidecar, _path, cb) {
        const files = fs.readdirSync(_path);
        async.forEach(files, (file, next_file)=>{
            if(file.startsWith(".")) return next_file();
            let fileinfo = parseBIDSPath(file);
            if(!fileinfo.task) fileinfo.task = "unknown"; //like ds001165
            switch(fileinfo._filename) {
            case "bold.nii":
            case "bold.nii.gz":

                //let fullname = fileinfo._fullname;
                //let sidecar_name = fullname.substring(0, fullname.length-fileinfo._filename.length)+"bold.json"; //remove .nii.gz to replace it with .json
                let basename = get_basename(fileinfo);
                let sidecar_name = basename+"bold.json";
                    
                //compose sidecar
                let sidecar = {};
                Object.assign(sidecar, parent_sidecar["bold.json"]);
                //Object.assign(sidecar, parent_sidecar[strip_hierachy(sidecar_name)]);
                Object.assign(sidecar, get_parent_sidecar(parent_sidecar, sidecar_name));
                Object.assign(sidecar, get_sidecar(_path+"/"+sidecar_name));

                let dataset = {
                    datatype: "neuro/func/task",
                    desc: fileinfo._fullname,
                    
                    datatype_tags: [ fileinfo.task.toLowerCase() ], 
                    tags: get_tags(fileinfo),

                    meta: Object.assign(sidecar, get_meta(fileinfo)),
                }
                let files = {
                    "bold.nii.gz": _path+"/"+fileinfo._fullname,
                };

                let events_fullname = _path+"/"+basename+"events.tsv"; 
                if(fs.existsSync(events_fullname)) {
                    files["events.tsv"] = events_fullname;
                }
                    
                //TODO - sbref.json could be stored on the parent directory without hierarchy.. 
                let sbref_fullname = _path+"/"+basename+"sbref.nii.gz"; 
                if(fs.existsSync(sbref_fullname)) {
                    files["sbref.nii.gz"] = sbref_fullname;
                }
                let sbrefjson_fullname = _path+"/"+basename+"sbref.json"; 
                if(fs.existsSync(sbrefjson_fullname)) {
                    files["sbref.json"] = sbrefjson_fullname;
                }

                let physio_fullname = _path+"/"+basename+"physio.tsv.gz"; 
                if(fs.existsSync(physio_fullname)) {
                    files["physio.tsv.gz"] = physio_fullname;
                }
                let physiojson_fullname = _path+"/"+basename+"physio.json"; 
                if(fs.existsSync(physiojson_fullname)) {
                    files["physio.json"] = physiojson_fullname;
                }

                bids.datasets.push({dataset, files});
                next_file(); 
                break;
            default:
                next_file(); 
            }
        }, cb);
    }

    function get_sidecar(path) {
        let sidecar = {};
        try {
            sidecar = fs.readFileSync(path, "utf8");
            sidecar = JSON.parse(sidecar);
        } catch (err) {
            //TODO - generates too many error messages
            //console.error('no sidecar!', path);
        }
        return sidecar;
    }

    function get_sidecar_from_fileinfo(dir, fileinfo, jsonname) {
        if(!fileinfo) return {}

        //let fullname = fileinfo._fullname;
        //let sidecar_name = fullname.substring(0, fullname.length-7)+".json"; //remove .nii.gz to replace it with .json
        let basename = get_basename(fileinfo);
        let sidecar = get_sidecar(dir+"/"+basename+jsonname);
        return sidecar;
    }

    function handle_anat_t1(derivatives, parent_sidecar, dir, fileinfo, cb) {
        //load (optional?) sidecar
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["T1w.json"]);
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, fileinfo, "T1w.json"));

        let dataset = {
            datatype: "neuro/anat/t1w",
            desc: fileinfo._fullname,
            datatype_tags: [],
            tags: get_tags(fileinfo),

            meta: Object.assign(sidecar, get_meta(fileinfo)),
        }

        let files = {"t1.nii.gz": dir+"/"+fileinfo._fullname};
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_anat_t2(derivatives, parent_sidecar, dir, fileinfo, cb) {
        //load sidecar
        let fullname = fileinfo._fullname;
        //let sidecar_name = fullname.substring(0, fullname.length-7)+".json"; //remove .nii.gz to replace it with .json
        //let sidecar = get_sidecar(dir+"/"+sidecar_name);
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["T2w.json"]);
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, fileinfo, "T2w.json"));
        
        let dataset = {
            datatype: "neuro/anat/t2w",
            desc: fileinfo._fullname,
            datatype_tags: [],
            tags: get_tags(fileinfo),

            meta: Object.assign(sidecar, get_meta(fileinfo)),
        }

        let files = {"t2.nii.gz": dir+"/"+fileinfo._fullname};
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_anat_flair(derivatives, parent_sidecar, dir, fileinfo, cb) {
        //load sidecar
        let fullname = fileinfo._fullname;
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["FLAIR.json"]); //TODO is this right? (I haven't seen it)
        Object.assign(sidecar, get_sidecar_from_fileinfo(dir, fileinfo, "FLAIR.json"));
        
        let dataset = {
            datatype: "neuro/anat/flair",
            desc: fileinfo._fullname,
            tags: get_tags(fileinfo),
            datatype_tags: [],

            meta: Object.assign(sidecar, get_meta(fileinfo)),
        }

        let files = {"flair.nii.gz": dir+"/"+fileinfo._fullname};
        bids.datasets.push({dataset, files});
        cb();
    }

    function handle_anat_mp2rage(derivatives, parent_sidecar, dir, infos, cb) {

        //load sidecar
        let fileinfo = infos.find(info=>info._filename == "MP2RAGE.nii.gz");
        let sidecar = {};
        Object.assign(sidecar, parent_sidecar["MP2RAGE.json"]); //TODO is this right (I haven't seen it)
        let basemeta = get_meta(fileinfo);
        Object.assign(sidecar, basemeta);
        
        //aggregate tags/meta
        let all_tags = [];
        infos.forEach(info=>{
            if(info._filename == "MP2RAGE.json") {
                all_tags = Array.from(new Set([...all_tags, ...get_tags(info)]));
                Object.assign(sidecar, get_sidecar_from_fileinfo(dir, fileinfo, "MP2RAGE.json"));
            }
        });
        delete sidecar.inv;
        delete sidecar.part;
 
        let dataset = {
            datatype: "neuro/anat/mp2rage",
            desc: dir,
            tags: all_tags,
            datatype_tags: [],
            meta: sidecar,
        }

        let files = {};
        infos.forEach(info=>{
            if(info._filename == "MP2RAGE.nii.gz") {
                files[info.part+".inv"+info.inv+".nii.gz"] = dir+"/"+fileinfo._fullname;
            }
            if(info._filename == "MP2RAGE.json") {
                files[info.part+".inv"+info.inv+".json"] = dir+"/"+fileinfo._fullname;
            }
        });

        //look for UNIT1 derivatives
        const key = [sidecar.subject,sidecar.session,"anat"].join(".");

        //construct string key like {subject:"123",session:"123"}
        delete basemeta.inv;
        delete basemeta.part;
        const baseMetaStr = JSON.stringify(basemeta);

        const unit1s = derivatives.find(d=>{
            if(d.key != key) return;
            d.infos.forEach(fileinfo=>{
                const metaStr = JSON.stringify(get_meta(fileinfo));
                if(baseMetaStr == metaStr) {
                    if(fileinfo._filename == "UNIT1.nii.gz") {
                        files["unit1.nii.gz"] = fileinfo._path+"/"+fileinfo._fullname;
                    }
                    if(fileinfo._filename == "UNIT1.json") {
                        files["unit1.json"] = fileinfo._path+"/"+fileinfo._fullname;
                    }
                }
            });
        });

        bids.datasets.push({dataset, files});
        cb();
     }
}
