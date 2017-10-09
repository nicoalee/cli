#!/usr/bin/env node

const request = require('request');
const argv = require('minimist')(process.argv.slice(2));
const config = require('./config');
const fs = require('fs');
const async = require('async');
const spawn = require('child_process').spawn;
const WebSocketClient = require('websocket').client;
const jsonwebtoken = require('jsonwebtoken');

if(!argv.tag) argv.tag = [];
if(!Array.isArray(argv.tag)) argv.tag = [argv.tag];

if(!argv.datatype_tag) argv.datatype_tag = [];
if(!Array.isArray(argv.datatype_tag)) argv.datatype_tag = [argv.datatype_tag];

//TODO validate input arguments
if(!argv.desc) throw new Error("desc missing");
if(!argv.project_id) throw new Error("project_id missing");
if(!argv.subject) throw new Error("subject missing");
const dir = argv._[0];

var ws = new WebSocketClient();
ws.on('connectFailed', function(err) {
    throw err;
});

//check if user is logged in
fs.stat(config.path.jwt, (err, stat)=>{
    if(err) {
        console.log("not logged in?");
        process.exit(1);
    }
    var jwt = fs.readFileSync(config.path.jwt);
    var user = jsonwebtoken.decode(jwt);
    var headers = { "Authorization": "Bearer "+jwt };
    var instance;
    get_instance(headers).then(_instance=>{
        instance = _instance;
        console.log("using instance", instance);
        return get_resource(headers);
    }).then(resource=>{
        run(headers, instance, resource);
    }).catch(err=>{
        console.error(err);
    });
});

var instance_name = "warehouse-cli.upload";
function get_instance(headers) {
    console.log("finding instance");
    return new Promise((resolve, reject)=>{
        //get instance that might already exist
        var find = { name: instance_name };
        request.get({url: config.api.wf+"/instance?find="+JSON.stringify(find), headers: headers, json: true}, function(err, res, body) {
            if(err) return reject(err);
            if(res.statusCode != 200) return reject(res.statusCode);
            if(body.instances[0]) resolve(body.instances[0]);
            else {
                //need to create new instance
                request.post({url: config.api.wf+"/instance", headers: headers, json: true, form: { name: instance_name },
                }, function(err, res, body) {
                    if(err) return reject(err);
                    resolve(body);
                }); 
            }
        });
    });
}

function get_resource(headers) {
    console.log("get resource");
    return new Promise((resolve, reject)=>{
        request.get({url: config.api.wf+"/resource/best?service=soichih/sca-service-noop", headers: headers, json: true}, function(err, res, body) {
            if(err) return reject(err);
            if(res.statusCode != 200) return reject(res.statusCode);
            if(!body.resource) return reject("no upload resource");
            resolve(body.resource);
        });
    });
}

function wait_for_finish(headers, task, cb) {
    var find = {_id: task._id};
    request.get({url: config.api.wf+"/task?find="+JSON.stringify(find), headers: headers, json: true}, function(err, res, body) {
        if(err) return cb(err);
        if(body.tasks[0].status == "finished") return cb();
        if(body.tasks[0].status == "failed") return cb(body.tasks[0].status_msg);
        console.log("waiting for job to finish..");
        setTimeout(function() {
            wait_for_finish(headers, task, cb);
        }, 1000);
    });
}

function run(headers, instance, resource) {
    //search for datatype specified
    var find = { name: argv.type }
    request.get({url: config.api.warehouse+"/datatype?find="+JSON.stringify(find), json: true}, function(err, res, body) {
        if(err) throw err;
        if(!body.datatypes) throw new Error("Failed to load datatypes");
        if(body.datatypes.length != 1) throw new Error("Failed to load exact 1 datatypes");
        var datatype = body.datatypes[0];

        console.log("datatype");
        console.dir(datatype);  
        
        //look for files we expect
        var taropts = ['-czh'];
        async.forEach(datatype.files, (file, next_file)=>{
            console.log("looking for", dir+'/'+(file.filename||file.dirname));
            fs.stat(dir+"/"+file.filename, (err,stats)=>{
                if(err) {
                    //try dirname?
                    if(file.dirname) {
                        console.log(file);
                        fs.stat(dir+"/"+file.dirname, (err,stats)=>{
                            if(err) throw err;
                            console.dir([file, stats]);
                            taropts.push(file.dirname);
                            next_file();
                        });
                    } else {
                        throw err;
                    }
                } else {
                    console.dir([file, stats]);
                    taropts.push(file.filename);
                    next_file();
                }
            });
        }, err=>{
            if(err) throw err;

            //submit noop to upload data
            //warehouse dataset post api need a real task to submit from
            request.post({url: config.api.wf+"/task", headers: headers, json: true, body: {
                instance_id: instance._id,
                name: "warehouse-cli.upload",
                service: "soichih/sca-service-noop",
            }}, function(err, res, body) {
                if(err) throw err;
                var task = body.task;
                console.log("task submitted");
                console.dir(body);

                console.log("uploading", task._id);
                var path = new Buffer(instance._id+'/'+task._id+'/upload.tar.gz').toString('base64');
                var req = request.post({url: config.api.wf+"/resource/upload/"+resource._id+"/"+path+"?untar=true", headers: headers});
                var tar = spawn('/bin/tar', taropts, {cwd: dir});
                tar.stdout.pipe(req).on('end', function() {
                    console.log("done uploading");

                    //TODO - should I submit validation/normalization task?
                    wait_for_finish(headers, task, function(err) {
                        console.log("service completed posting to warehouse");
                        request.post({url: config.api.warehouse+'/dataset', json: true, headers: headers, body: {
                            //info for dataset
                            project: argv.project_id,
                            //name: argv.name,
                            desc: argv.desc,
                            datatype: datatype._id,
                            datatype_tags: argv.datatype_tag,
                            tags: argv.tag, 

                            meta: {subject: argv.subject},

                            instance_id: instance._id,
                            task_id: task._id, //we archive data from copy task
                            //output_id: argv.output_id,
                        }}, function(err, res, body) {
                            if(err) throw err;
                            console.log("dataset registgered");
                            console.dir(body);
                        });
                    });
                });
            });
        });
    });
}

