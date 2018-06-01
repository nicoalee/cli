const config = require('./config');
const argv = require('minimist')(process.argv.slice(2));
const commander = require('commander');
const util = require('./util');

commander
    .option('--id <app id>', 'id of app to run')
    .option('--input <input id>', 'add an input to the application (by input id)')
    .option('--output <output id>', 'add an output to the application (by output id)')
    .option('--project <project id>', 'the project to store the output dataset from an app')
    .option('--preferred-resource <resource id>', 'user-preferred resource to use to run an app')
    .option('--config <json string>', 'config to use for running the app')
    .option('-r, --raw', 'output resulting app task in json format')
    .option('-r, --json', 'output resulting app task in json format')
    .option('-h, --h')
    .parse(process.argv);

util.loadJwt().then(jwt => {
    commander.raw = commander.raw || commander.json;
    if (commander.h) commander.help();
    let headers = { "Authorization": "Bearer " + jwt };
    let datatypeTable = {};
    
    if (!commander.project) throw "Error: No project given to store output dataset";
    if (!commander.id) throw "Error: No app id given";
    
    if (!argv['input']) argv['input'] = [];
    if (!Array.isArray(argv['input'])) argv['input'] = [ argv['input'] ];
    
    util.runApp(headers, commander.id, argv['input'], commander.project, commander.preferredResource, commander.config, commander.raw).then(task => {
        if (commander.raw) console.log(task);
    });
}).catch(console.error);