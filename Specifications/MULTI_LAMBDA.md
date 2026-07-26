# Specification Document for Multi Lambda CAUCSim Architecture

## Background
Current CAUCSim lambda app contains fuctionality for 
- User authentification
- CAD model loading and viewing
- CFD simulation of model performance via openFOAM
- Display and visualisation of results
This is all contained within a single page web app.

## Target State
System to be expanded to have additional simulation elements 
- Simulation of F24 Vehicle performance showing distance travelled in 90min based on vehicle information such as mass, CD, tyre rolling resistance, power consumption (Volts x Amps)
- Viewing and download of previous Simulation results (CFD and Performance) 

## Proposed Architecture
Current single lambda function app to become 4 lambda functions :
    1. authentication (from current app) and new routing to CFD, Performance or Results pages
    2. CFD Simulation page (bulk of current app)
    3. Performance Simulation App (new app)
    4. Results app (new app)
