/*global require, setTimeout, setInterval, exports*/
'use strict';
var logger = require('./logger').logger;
var Scheduler = require('./scheduler').Scheduler;

// Logger
var log = logger.getLogger('ClusterManager');

var ClusterManager = function (clusterName, selfId, spec) {
    var that = {name: clusterName,
                id: selfId};

    /*initializing | in-service*/
    var state = 'initializing',
        is_freshman = true,
        monitoringTarget,

        initial_time = spec.initialTime,
        check_alive_period = spec.checkAlivePeriod,
        check_alive_count = spec.checkAliveCount;

    /* {Purpose: Scheduler}*/
    var schedulers = {};

    /*Id : {purpose: Purpose, alive_count: Number, info: Info}*/
    var workers = {};

    var data_synchronizer;

    var createScheduler = function (purpose) {
        var strategy = spec.hasOwnProperty(purpose + 'Strategy') ? spec[purpose + 'Strategy'] : spec.generalStrategy;
        return new Scheduler({strategy: strategy, scheduleReserveTime: spec.scheduleReserveTime});
    };

    var checkAlive = function () {
        for (var worker in workers) {
            workers[worker].alive_count += 1;
            if (workers[worker].alive_count > check_alive_count) {
                log.info('Worker', worker, 'is not alive any longer, Deleting it.');
                workerQuit(worker);
            }
        }
    };

    var workerJoin = function (purpose, worker, info) {
        log.debug('workerJoin, purpose:', purpose, 'worker:', worker, 'info:', info);
        schedulers[purpose] = schedulers[purpose] || createScheduler(purpose);
        schedulers[purpose].add(worker, info.state, info.max_load);
        workers[worker] = {purpose: purpose,
                           info: info,
                           alive_count: 0};
        data_synchronizer && data_synchronizer({type: 'worker_join', payload: {purpose: purpose, worker: worker, info: info}});
        return state;
    };

    var workerQuit = function (worker) {
        log.debug('workerQuit, worker:', worker);
        if (workers[worker] && schedulers[workers[worker].purpose]) {
            schedulers[workers[worker].purpose].remove(worker);
            monitoringTarget && monitoringTarget.notify('quit', {purpose: workers[worker].purpose, id: worker, type: 'worker'});
            delete workers[worker];
            data_synchronizer && data_synchronizer({type: 'worker_quit', payload: {worker: worker}});
        }
    };

    var keepAlive = function (worker, on_result) {
        if (workers[worker]) {
            workers[worker].alive_count = 0;
            on_result('ok');
        } else {
            on_result('whoareyou');
        }
    };

    var reportState = function (worker, state) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].updateState(worker, state);
        data_synchronizer && data_synchronizer({type: 'worker_state', payload: {worker: worker, state: state}});
    };

    var reportLoad = function (worker, load) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].updateLoad(worker, load);
        data_synchronizer && data_synchronizer({type: 'worker_load', payload: {worker: worker, load: load}});
    };

    var pickUpTasks = function (worker, tasks) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].pickUpTasks(worker, tasks);
        data_synchronizer && data_synchronizer({type: 'worker_pickup', payload: {worker: worker, tasks: tasks}});
    };

    var layDownTask = function (worker, task) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].layDownTask(worker, task);
        data_synchronizer && data_synchronizer({type: 'worker_laydown', payload: {worker: worker, task: task}});
    };

    var schedule = function (purpose, task, reserveTime, on_ok, on_error) {
        log.debug('schedule, purpose:', purpose, 'task:', task, 'reserveTime:', reserveTime, 'while state:', state);
        if (state === 'in-service') {
            if (schedulers[purpose]) {
                schedulers[purpose].schedule(task, reserveTime, function(worker) {
                    log.debug('schedule OK, got  worker', worker);
                    on_ok(worker, workers[worker].info);
                    data_synchronizer && data_synchronizer({type: 'scheduled', payload: {purpose: purpose, task: task, worker: worker, reserve_time: reserveTime}});
                }, function (reason) {
                    log.warn('schedule failed:', reason);
                    on_error(reason);
                });
            } else {
                log.warn('No scheduler for purpose:', purpose);
                on_error('No scheduler for purpose: ' + purpose);
            }
        } else {
           log.warn('cluster manager is not ready.');
           on_error('cluster manager is not ready.');
        }
    };

    var unschedule = function (worker, task) {
        workers[worker] && schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].unschedule(worker, task);
        data_synchronizer && data_synchronizer({type: 'unscheduled', payload: {worker: worker, task: task}});
    };

    var getWorkerAttr = function (worker, on_ok, on_error) {
        if (workers[worker]) {
            // FIXME: the following attr items are for purpose of compaticity with legacy oam client, should be refined later.
            if (workers[worker].purpose === 'portal') {
                var scheduling_info = schedulers[workers[worker].purpose] && schedulers[workers[worker].purpose].getInfo(worker);
                scheduling_info = scheduling_info || {state: 0, load: 0, max_load: 1.0, tasks: []};
                on_ok({id: worker,
                       purpose: workers[worker].purpose,
                       ip: workers[worker].info.ip,
                       rpcID: worker,
                       state: scheduling_info.state,
                       load: scheduling_info.load,
                       hostname: workers[worker].info.hostname || '',
                       port: workers[worker].info.port || 0,
                       keepAlive: workers[worker].alive_count});
            } else {
                on_ok(workers[worker].info);
            }
        } else {
            on_error('Worker [' + worker + '] does NOT exist.');
        }
    };

    var getWorkers = function (purpose, on_ok) {
        if (purpose === 'all') {
            on_ok(Object.keys(workers));
        } else {
            var result = [];
            for (var worker in workers) {
                if (workers[worker].purpose === purpose) {
                    result.push(worker);
                }
            }
            on_ok(result);
        }
    };

    var getTasks = function (worker, on_ok) {
        return workers[worker] && schedulers[workers[worker].purpose] ? schedulers[workers[worker].purpose].getTasks(worker) : [];
    };

    var getScheduled = function (purpose, task, on_ok, on_error) {
        if (schedulers[purpose]) {
            schedulers[purpose].getScheduled(task, on_ok, on_error);
        } else {
            on_error('Invalid purpose.');
        }
    };

    that.getRuntimeData = function (on_data) {
        var data = {schedulers: {}, workers: workers};
        for (var purpose in schedulers) {
            data.schedulers[purpose] = schedulers[purpose].getData();
        }
        on_data(data);
    };

    that.registerDataUpdate = function (on_updated_data) {
        data_synchronizer = on_updated_data;
    };

    that.setRuntimeData = function (data) {
         if (is_freshman) {
             log.debug('onRuntimeData, data:', data);
             workers = data.workers;
             for (var purpose in data.schedulers) {
                 schedulers[purpose] = createScheduler(purpose);
                 schedulers[purpose].setData(data.schedulers[purpose]);
             }
             is_freshman = false;
         }
    };

    that.setUpdatedData = function (data) {
        if (is_freshman) {
            return;
        }
        log.debug('onUpdatedData, data:', data);
        switch (data.type) {
        case 'worker_join':
            workerJoin(data.payload.purpose, data.payload.worker, data.payload.info);
            break;
        case 'worker_quit':
            workerQuit(data.payload.worker);
            break;
        case 'worker_state':
            reportState(data.payload.worker, data.payload.state);
            break;
        case 'worker_load':
            reportLoad(data.payload.worker, data.payload.load);
            break;
        case 'worker_pickup':
            pickUpTasks(data.payload.worker, data.payload.tasks);
            break;
        case 'worker_laydown':
            layDownTask(data.payload.worker, data.payload.task);
            break;
        case 'scheduled':
            schedulers[data.payload.purpose] && schedulers[data.payload.purpose].setScheduled(data.payload.task, data.payload.worker, data.payload.reserve_time);
            break;
        case 'unscheduled':
            unschedule(data.payload.worker, data.payload.task);
            break;
        default:
            log.warn('unknown updated data type:', data.type);
        }
    };

    that.serve = function (monitoringTgt) {
        if (is_freshman) {
            setTimeout(function () {
                state = 'in-service';
            }, initial_time);
        } else {
            state = 'in-service';
        }
        is_freshman = false;
        monitoringTarget = monitoringTgt;
        setInterval(checkAlive, check_alive_period);
        for (var purpose in schedulers) {
            schedulers[purpose].serve();
        }
    };

    that.rpcAPI = {
        join: function (purpose, worker, info, callback) {
            var result = workerJoin(purpose, worker, info);
            callback('callback', result);
        },
        quit: function (worker) {
            workerQuit(worker);
        },
        keepAlive: function (worker, callback) {
            keepAlive(worker, function (result) {
                callback('callback', result);
            });
        },
        reportState: function (worker, state) {
            reportState(worker, state);
        },
        reportLoad: function (worker, load) {
            reportLoad(worker, load);
        },
        pickUpTasks: function (worker, tasks) {
            pickUpTasks(worker, tasks);
        },
        layDownTask: function (worker, task) {
            layDownTask(worker, task);
        },
        schedule: function (purpose, task, reserveTime, callback) {
            schedule(purpose, task, reserveTime, function(worker, info) {
                callback('callback', {id: worker, info: info});
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        },
        unschedule: function (worker, task) {
            unschedule(worker, task);
        },
        getWorkerAttr: function (worker, callback) {
            getWorkerAttr(worker, function (attr) {
                callback('callback', attr);
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        },
        getWorkers: function (purpose, callback) {
            getWorkers(purpose, function (workerList) {
                callback('callback', workerList);
            });
        },
        getTasks: function (worker, callback) {
            getTasks(worker, function (taskList) {
                callback('callback', taskList);
            });
        },
        getScheduled: function (purpose, task, callback) {
            getScheduled(purpose, task, function (worker) {
                callback('callback', worker);
            }, function (error_reason) {
                callback('callback', 'error', error_reason);
            });
        }
    };

    return that;
};

var runAsSlave = function(topicChannel, manager) {
    var loss_count = 0,
        interval;

    var requestRuntimeData = function () {
        topicChannel.publish('clusterManager.master', {type: 'requestRuntimeData', data: manager.id});
    };

    var onTopicMessage = function(message) {
        if (message.type === 'runtimeData') {
            manager.setRuntimeData(message.data);
        } else if (message.type === 'updateData') {
            manager.setUpdatedData(message.data);
        } else if (message.type === 'declareMaster') {
            loss_count = 0;
        } else {
            log.info('slave, not concerned message:', message);
        }
    };

    var superviseMaster = function () {
        interval = setInterval(function () {
            loss_count++;
            if (loss_count > 2) {
                log.info('Lose heart-beat from master.');
                clearInterval(interval);
                topicChannel.unsubscribe(['clusterManager.slave.#', 'clusterManager.*.' + manager.id]);
                runAsCandidate(topicChannel, manager, 0);
            }
        }, 30);
    };

    log.info('Run as slave.');
    topicChannel.subscribe(['clusterManager.slave.#', 'clusterManager.*.' + manager.id], onTopicMessage, function () {
        requestRuntimeData();
        superviseMaster();
    });
};

var runAsMaster = function(topicChannel, manager) {
    log.info('Run as master.');
    topicChannel.bus.asRpcServer(manager.name, manager.rpcAPI, function(rpcSvr) {
        topicChannel.bus.asMonitoringTarget(function(monitoringTgt) {
            manager.serve(monitoringTgt);
            setInterval(function () {
                //log.info('Send out heart-beat as master.');
                topicChannel.publish('clusterManager.slave', {type: 'declareMaster', data: manager.id});
                topicChannel.publish('clusterManager.candidate', {type: 'declareMaster', data: manager.id});
            }, 20);

            var onTopicMessage = function (message) {
                if (message.type === 'requestRuntimeData') {
                    var from = message.data;
                    log.info('requestRuntimeData from:', from);
                    manager.getRuntimeData(function (data) {
                        topicChannel.publish('clusterManager.slave.' + from, {type: 'runtimeData', data: data});
                    });
                }
            };

            topicChannel.subscribe(['clusterManager.master.#', 'clusterManager.*.' + manager.id], onTopicMessage, function () {
                log.info('Cluster manager is in service as master!');
                manager.registerDataUpdate(function (data) {
                    topicChannel.publish('clusterManager.slave', {type: 'updateData', data: data});
                });
            });
        }, function(reason) {
            log.error('Cluster manager running as monitoring target failed, reason:', reason);
            process.exit();
        });
    }, function(reason) {
        log.error('Cluster manager running as RPC server failed, reason:', reason);
        process.exit();
    });
};

var runAsCandidate = function(topicChannel, manager) {
    var am_i_the_one = true,
        timer,
        interval;

    var electMaster = function () {
        interval && clearInterval(interval);
        interval = undefined;
        timer = undefined;
        topicChannel.unsubscribe(['clusterManager.candidate.#']);
        if (am_i_the_one) {
            runAsMaster(topicChannel, manager);
        } else {
            runAsSlave(topicChannel, manager);
        }
    };

    var selfRecommend = function () {
        interval = setInterval(function () {
            log.info('Send self recommendation..');
            topicChannel.publish('clusterManager.candidate', {type: 'selfRecommend', data: manager.id});
        }, 30);
    };

    var onTopicMessage = function (message) {
        if (message.type === 'selfRecommend') {
            if (message.data > manager.id) {
                am_i_the_one = false;
            }
        } else if (message.type === 'declareMaster') {
            log.info('Someone else became master.');
            interval && clearInterval(interval);
            interval = undefined;
            timer && clearTimeout(timer);
            timer = undefined;
            topicChannel.unsubscribe(['clusterManager.#']);
            runAsSlave(topicChannel, manager);
        }
    };

    log.info('Run as candidate.');
    topicChannel.subscribe(['clusterManager.candidate.#'], onTopicMessage, function () {
        timer = setTimeout(electMaster, 160);
        selfRecommend();
    });
};

exports.run = function (topicChannel, clusterName, id, spec) {
    var manager = new ClusterManager(clusterName, id, spec);

    runAsCandidate(topicChannel, manager);
};

