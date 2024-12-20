try {
    var logtag = '[ Maintenance Script ] ';
    var params = JSON.parse(value);

    var api_url = params.api_url;
    var api_token = params.api_token;
    var periodInput = params.period;
    var hostname = params.hostname;

    if (!api_url) throw 'Missing param api_url';
    if (!api_token) throw 'Missing param api_token';
    if (!hostname) throw 'Missing param hostname';
    if (periodInput === undefined) throw 'Missing param period';

    function convertToSeconds(periodStr) {
        var timeUnits = {
            y: 31536000,
            M: 2592000,
            d: 86400,
            h: 3600,
            m: 60,
            s: 1
        };

        var regex = /(\d+)([yMdhms]?)/g;
        var matches;
        var totalSeconds = 0;

        while ((matches = regex.exec(periodStr)) !== null) {
            var val = parseInt(matches[1]);
            var unit = matches[2] || 's';
            if (timeUnits[unit]) {
                totalSeconds += val * timeUnits[unit];
            }
        }
        return totalSeconds;
    }

    var period = convertToSeconds(periodInput);
    Zabbix.Log(3, logtag + 'Input period: ' + periodInput + ' => seconds: ' + period);

    // If period > 0 but < 600, set to 600
    if (period > 0 && period < 600) {
        Zabbix.Log(3, logtag + 'Period is less than 600 seconds, setting period to 600 seconds.');
        period = 600;
    }

    var httpreq = new HttpRequest();
    httpreq.addHeader('Content-Type: application/json');
    httpreq.addHeader('Authorization: Bearer ' + api_token);

    function zbxApiCall(method, paramsObj) {
        var data = {
            jsonrpc: "2.0",
            method: method,
            params: paramsObj,
            id: 1
        };

        var response = httpreq.post(api_url, JSON.stringify(data));
        var responseObj;
        try {
            responseObj = JSON.parse(response);
        } catch (e) {
            throw 'Invalid JSON response from API: ' + response;
        }

        if (responseObj.error) {
            throw 'API error: ' + JSON.stringify(responseObj.error);
        }

        return responseObj.result;
    }

    // Detect Host id
    var hostInfo = zbxApiCall('host.get', {
        filter: { host: [hostname] },
        output: ["hostid", "host"]
    });

    if (!hostInfo || hostInfo.length === 0) {
        throw 'Host "' + hostname + '" not found!';
    }

    var hostid = hostInfo[0].hostid;
    Zabbix.Log(3, logtag + 'Found host: ' + hostname + ' with hostid: ' + hostid);

    // Get existing Script-Maintenances
    var maintenances = zbxApiCall('maintenance.get', {
        hostids: [hostid],
        output: "extend"
    });

    Zabbix.Log(3, logtag + 'Found maintenances for host: ' + hostname + ': ' + JSON.stringify(maintenances));

    var scriptMaintenanceName = "Script Maintenance Host: " + hostname;
    var existingMaintenance = null;
    if (maintenances && maintenances.length > 0) {
        for (var i = 0; i < maintenances.length; i++) {
            if (maintenances[i].name === scriptMaintenanceName) {
                existingMaintenance = maintenances[i];
                break;
            }
        }
    }

    var time_now = Math.floor(Date.now() / 1000);
    var MAX_ACTIVE_TILL = 2147468400;
    var time_end = (period > 0) ? (period > (MAX_ACTIVE_TILL - time_now) ? MAX_ACTIVE_TILL : time_now + period) : null;

    if (period === 0) {
        // Delete maintenance if value is 0 and a script maintenance exists 
        if (existingMaintenance) {
            Zabbix.Log(3, logtag + 'Period=0, deleting existing script maintenance: ' + existingMaintenance.maintenanceid);
            var delResult = zbxApiCall('maintenance.delete', [existingMaintenance.maintenanceid]);
            Zabbix.Log(4, logtag + 'Deleted maintenance: ' + JSON.stringify(delResult));
            return "Maintenance deleted.";
        } else {
            Zabbix.Log(3, logtag + 'Period=0, but no script maintenance found. Doing nothing.');
            return "No script-created maintenance found. Nothing to do.";
        }
    }

    // period > 0 -> create or update maintenance for given host
    var date = new Date(time_end * 1000);
    var dateString = date.toLocaleString();
    var description = "Managed by Zabbix Script. Until: " + dateString;

    if (existingMaintenance) {
        // Update existing Maintenance
        Zabbix.Log(3, logtag + 'Updating existing script maintenance: ' + existingMaintenance.maintenanceid + ' with new period: ' + period);
        var updateParams = {
            maintenanceid: existingMaintenance.maintenanceid,
            active_since: time_now,
            active_till: time_end,
            timeperiods: [{
                "timeperiod_type": 0,
                "period": period
            }],
            description: description
        };
        var updateResult = zbxApiCall('maintenance.update', updateParams);
        Zabbix.Log(4, logtag + 'Updated maintenance: ' + JSON.stringify(updateResult));
        return "Maintenance updated until " + dateString;
    } else {
        // Create new maintenance
        Zabbix.Log(3, logtag + 'Creating new script maintenance with period: ' + period);
        var createParams = {
            name: scriptMaintenanceName,
            active_since: time_now,
            active_till: time_end,
            description: description,
            maintenance_type: 0,
            timeperiods: [{
                "timeperiod_type": 0,
                "period": period
            }],
            hosts: [{hostid: hostid}]
        };
        var createResult = zbxApiCall('maintenance.create', createParams);
        Zabbix.Log(4, logtag + 'Created maintenance: ' + JSON.stringify(createResult));
        return "Maintenance created until " + dateString;
    }

} catch (error) {
    Zabbix.Log(3, '[ Maintenance Script ] Error: ' + error);
    return "Error: " + error;
}
